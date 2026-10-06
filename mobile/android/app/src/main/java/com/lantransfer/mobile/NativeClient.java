package com.lantransfer.mobile;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.Build;
import android.os.Environment;
import android.content.ContentValues;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Pure Android LTP/1 client. No WebView or Capacitor runtime is required. */
final class NativeClient {
    interface Listener { void onConnected(String serverName); void onError(String message); void onClosed(); void onProgress(int percent); default void onIncomingOffer(String label) {} }
    static final int PORT = 53317;
    static final int CHUNK_SIZE = 256 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService transferIo = Executors.newSingleThreadExecutor();
    private final Listener listener; private final String deviceId; private final String deviceName;
    private ContentResolver resolver; private List<FileRef> pendingFiles = new ArrayList<>(); private String pendingTransferId;
    private Socket socket; private OutputStream output; private volatile boolean closed; private int seq;
    private volatile boolean connected;
    private byte[] receiveBuffer = new byte[0];
    private final java.util.Map<String, ReceiveFile> receiving = new java.util.HashMap<>();
    private JSONObject pendingIncomingOffer;

    NativeClient(String deviceId, String deviceName, Listener listener) { this.deviceId = deviceId; this.deviceName = deviceName; this.listener = listener; }

    void connect(String host, int port, String pairCode) {
        connectInternal(host, port, new JSONObjectAuth("pair", pairCode, null));
    }

    void connectWithQr(String host, int port, String token) {
        connectInternal(host, port, new JSONObjectAuth("pair", null, token));
    }

    boolean isConnected() { return connected && socket != null && socket.isConnected() && !socket.isClosed(); }

    private void connectInternal(String host, int port, JSONObjectAuth authData) {
        io.execute(() -> {
            try {
                socket = openSocket(host, port); output = socket.getOutputStream();
                JSONObject auth = new JSONObject().put("mode", authData.mode);
                if (authData.code != null) auth.put("pairCode", authData.code);
                if (authData.token != null) auth.put("token", authData.token);
                sendJson(message("hello").put("device", new JSONObject().put("deviceId", deviceId).put("name", deviceName).put("type", "mobile").put("os", "Android")).put("auth", auth));
                BufferedInputStream input = new BufferedInputStream(socket.getInputStream()); byte[] buffer = new byte[32 * 1024]; int count;
                while (!closed && (count = input.read(buffer)) != -1) feedIncoming(buffer, count);
                if (!closed) listener.onClosed();
            } catch (Exception e) { connected = false; if (!closed) listener.onError(friendlyError(host, port, e)); }
        });
    }

    private Socket openSocket(String host, int port) throws IOException {
        try {
            Socket s = new Socket(); s.setTcpNoDelay(true); s.setKeepAlive(true); s.connect(new InetSocketAddress(host, port), 8000); return s;
        } catch (IOException first) {
            if (!isEmulator() || "10.0.2.2".equals(host)) throw first;
            Socket fallback = new Socket(); fallback.setTcpNoDelay(true); fallback.setKeepAlive(true); fallback.connect(new InetSocketAddress("10.0.2.2", port), 8000); return fallback;
        }
    }

    private static boolean isEmulator() {
        return Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.startsWith("unknown") || Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK");
    }

    private static String friendlyError(String host, int port, Exception e) {
        String raw = e.getMessage() == null ? "未知网络错误" : e.getMessage();
        if (raw.contains("ECONNREFUSED") || raw.contains("Connection refused")) return "电脑端未接受连接，请确认邻传已启动且端口 " + port + " 未被防火墙拦截";
        if (raw.contains("ETIMEDOUT") || raw.contains("timed out") || raw.contains("timeout")) return "连接电脑超时：" + host + ":" + port + "。请确认手机和电脑在同一 Wi‑Fi；模拟器已自动尝试宿主机地址";
        return "连接失败：" + raw;
    }

    private void handleMessage(String line) {
        if (line.isEmpty()) return;
        try { JSONObject msg = new JSONObject(line); String type = msg.optString("type");
            if ("hello_ack".equals(type)) { if (msg.optBoolean("accepted", false)) { connected = true; listener.onConnected(msg.optJSONObject("server") == null ? "电脑" : msg.getJSONObject("server").optString("name", "电脑")); } else listener.onError(reason(msg.optString("reason"))); }
            else if ("send_offer".equals(type)) prepareIncomingOffer(msg);
            else if ("complete".equals(type)) finishIncomingFile(msg.optString("fileId"));
            else if ("send_accept".equals(type)) sendPendingFiles(msg);
            else if ("ping".equals(type)) sendJson(message("pong"));
            else if ("error".equals(type)) listener.onError(msg.optString("message", "电脑端返回错误"));
        } catch (Exception ignored) { }
    }

    private synchronized void feedIncoming(byte[] data, int count) throws Exception {
        byte[] next = new byte[receiveBuffer.length + count]; System.arraycopy(receiveBuffer, 0, next, 0, receiveBuffer.length); System.arraycopy(data, 0, next, receiveBuffer.length, count); receiveBuffer = next;
        while (receiveBuffer.length > 0) {
            if (receiveBuffer.length >= 4 && receiveBuffer[0] == 'L' && receiveBuffer[1] == 'T' && receiveBuffer[2] == 'P' && receiveBuffer[3] == 'C') {
                if (receiveBuffer.length < 6) return;
                int idLen = ((receiveBuffer[4] & 255) << 8) | (receiveBuffer[5] & 255); int header = 14 + idLen;
                if (receiveBuffer.length < header) return;
                int payloadLen = ((receiveBuffer[10 + idLen] & 255) << 24) | ((receiveBuffer[11 + idLen] & 255) << 16) | ((receiveBuffer[12 + idLen] & 255) << 8) | (receiveBuffer[13 + idLen] & 255);
                if (receiveBuffer.length < header + payloadLen) return;
                String fileId = new String(receiveBuffer, 6, idLen, StandardCharsets.UTF_8); byte[] payload = new byte[payloadLen]; System.arraycopy(receiveBuffer, header, payload, 0, payloadLen); consume(header + payloadLen); receiveChunk(fileId, payload); continue;
            }
            int nl = -1; for (int i = 0; i < receiveBuffer.length; i++) if (receiveBuffer[i] == '\n') { nl = i; break; }
            if (nl < 0) return; String line = new String(receiveBuffer, 0, nl, StandardCharsets.UTF_8).trim(); consume(nl + 1); if (!line.isEmpty()) handleMessage(line);
        }
    }

    private void consume(int count) { byte[] rest = new byte[receiveBuffer.length - count]; System.arraycopy(receiveBuffer, count, rest, 0, rest.length); receiveBuffer = rest; }

    private synchronized void prepareIncomingOffer(JSONObject msg) throws Exception {
        String transferId = msg.optString("transferId"); JSONArray files = msg.optJSONArray("files"); if (files == null || files.length() == 0) return;
        pendingIncomingOffer = msg;
        String label = files.length() == 1 ? files.getJSONObject(0).optString("name", "文件") : files.length() + " 个文件"; listener.onIncomingOffer(label);
    }

    void acceptIncomingOffer() {
        final JSONObject offer;
        synchronized (this) { offer = pendingIncomingOffer; pendingIncomingOffer = null; }
        if (offer == null) return;
        transferIo.execute(() -> { try { acceptIncomingOfferNow(offer); } catch (Exception e) { listener.onError("接收准备失败：" + (e.getMessage() == null ? "无法创建文件" : e.getMessage())); } });
    }

    void rejectIncomingOffer() {
        final JSONObject offer;
        synchronized (this) { offer = pendingIncomingOffer; pendingIncomingOffer = null; }
        if (offer == null) return;
        try { sendJson(message("send_reject").put("transferId", offer.optString("transferId")).put("reason", "user_denied")); } catch (Exception e) { listener.onError("拒绝接收失败"); }
    }

    private void acceptIncomingOfferNow(JSONObject msg) throws Exception {
        String transferId = msg.optString("transferId"); JSONArray files = msg.optJSONArray("files");
        JSONArray resume = new JSONArray();
        String savePath = "下载/邻传";
        for (int i = 0; i < files.length(); i++) { JSONObject f = files.getJSONObject(i); String id = f.optString("fileId"); String name = safeName(f.optString("name", "file")); ReceiveFile rf = createReceiveFile(transferId, id, f.optLong("size", 0), name, f.optString("mime", "application/octet-stream")); receiving.put(id, rf); }
        sendJson(message("send_accept").put("transferId", transferId).put("acceptedBy", deviceName).put("resume", resume).put("saveTo", savePath));
    }

    private ReceiveFile createReceiveFile(String transferId, String id, long size, String name, String mime) throws IOException {
        try {
            if (Build.VERSION.SDK_INT >= 29 && listener instanceof MainActivity) {
                ContentValues v = new ContentValues(); v.put(MediaStore.Downloads.DISPLAY_NAME, name); v.put(MediaStore.Downloads.MIME_TYPE, mime); v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/邻传"); v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = ((MainActivity) listener).getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v); if (uri != null) return new ReceiveFile(transferId, id, size, name, uri, ((MainActivity) listener).getContentResolver().openOutputStream(uri));
            }
        } catch (Exception ignored) { }
        File dir = new File(((MainActivity) listener).getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "received"); if (!dir.exists()) dir.mkdirs(); File out = new File(dir, name); return new ReceiveFile(transferId, id, size, name, Uri.fromFile(out), new FileOutputStream(out, true));
    }

    private void receiveChunk(String fileId, byte[] payload) throws IOException { ReceiveFile f = receiving.get(fileId); if (f == null) return; f.output.write(payload); f.received += payload.length; if (f.size > 0) listener.onProgress((int) Math.min(99, f.received * 100L / f.size)); }

    private void finishIncomingFile(String fileId) throws IOException { ReceiveFile f = receiving.remove(fileId); if (f != null && f.output != null) { f.output.flush(); f.output.close(); if (Build.VERSION.SDK_INT >= 29 && listener instanceof MainActivity && "content".equals(f.uri.getScheme())) { ContentValues v = new ContentValues(); v.put(MediaStore.Downloads.IS_PENDING, 0); ((MainActivity) listener).getContentResolver().update(f.uri, v, null, null); } listener.onProgress(100); } }

    private static String safeName(String name) { return name.replaceAll("[\\\\/:*?\"<>|]", "_"); }

    void sendFiles(ContentResolver resolver, List<Uri> uris) {
        transferIo.execute(() -> { try { JSONArray files = new JSONArray(); long total = 0; int index = 1; this.resolver = resolver; pendingFiles.clear();
            for (Uri uri : uris) { FileRef ref = inspect(resolver, uri, "f_" + index++); pendingFiles.add(ref); total += ref.size; files.put(new JSONObject().put("fileId", ref.id).put("name", ref.name).put("size", ref.size).put("mime", ref.mime).put("relPath", ref.name).put("isDir", false).put("mtime", System.currentTimeMillis()).put("chunkSize", CHUNK_SIZE).put("sha256", "")); }
            pendingTransferId = "t_a_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
            sendJson(message("send_offer").put("transferId", pendingTransferId).put("files", files).put("totalBytes", total)); listener.onProgress(0);
        } catch (Exception e) { listener.onError(e.getMessage() == null ? "发送失败" : e.getMessage()); } });
    }

    private void sendPendingFiles(JSONObject accept) throws Exception {
        if (resolver == null || pendingFiles.isEmpty() || pendingTransferId == null) return;
        JSONArray resume = accept.optJSONArray("resume"); long completed = 0; long total = 0;
        for (FileRef f : pendingFiles) total += f.size;
        for (FileRef f : pendingFiles) {
            long start = 0;
            if (resume != null) for (int i = 0; i < resume.length(); i++) { JSONObject r = resume.optJSONObject(i); if (r != null && f.id.equals(r.optString("fileId"))) start = Math.max(0, Math.min(f.size, r.optLong("receivedBytes", 0))); }
            completed += sendFile(f, start, total, completed);
            sendJson(message("complete").put("transferId", pendingTransferId).put("fileId", f.id).put("path", f.name).put("size", f.size));
        }
        listener.onProgress(100); pendingFiles.clear(); pendingTransferId = null;
    }

    private long sendFile(FileRef file, long start, long total, long completed) throws Exception {
        try (InputStream input = resolver.openInputStream(file.uri)) {
            if (input == null) throw new IOException("无法读取文件：" + file.name);
            long skipped = 0; while (skipped < start) { long n = input.skip(start - skipped); if (n <= 0) break; skipped += n; }
            byte[] chunk = new byte[CHUNK_SIZE]; int seq = (int) (start / CHUNK_SIZE); long sent = start; int count;
            while (!closed && (count = readChunk(input, chunk)) > 0) { sendBinary(encodeFrame(file.id, seq++, chunk, count)); sent += count; listener.onProgress((int) Math.min(99, ((completed + sent) * 100L) / Math.max(1, total))); }
            return sent;
        }
    }

    private static int readChunk(InputStream input, byte[] buffer) throws IOException { int total = 0, n; while (total < buffer.length && (n = input.read(buffer, total, buffer.length - total)) > 0) total += n; return total; }
    private synchronized void sendBinary(byte[] bytes) throws IOException { output.write(bytes); output.flush(); }
    private static byte[] encodeFrame(String fileId, int seq, byte[] payload, int length) { byte[] id = fileId.getBytes(StandardCharsets.UTF_8); byte[] frame = new byte[14 + id.length + length]; frame[0] = 'L'; frame[1] = 'T'; frame[2] = 'P'; frame[3] = 'C'; frame[4] = (byte) (id.length >>> 8); frame[5] = (byte) id.length; System.arraycopy(id, 0, frame, 6, id.length); int o = 6 + id.length; frame[o] = (byte) (seq >>> 24); frame[o + 1] = (byte) (seq >>> 16); frame[o + 2] = (byte) (seq >>> 8); frame[o + 3] = (byte) seq; frame[o + 4] = (byte) (length >>> 24); frame[o + 5] = (byte) (length >>> 16); frame[o + 6] = (byte) (length >>> 8); frame[o + 7] = (byte) length; System.arraycopy(payload, 0, frame, o + 8, length); return frame; }

    private FileRef inspect(ContentResolver resolver, Uri uri, String id) throws Exception { String name = "文件"; long size = 0; try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) { if (cursor != null && cursor.moveToFirst()) { name = cursor.getString(0) == null ? name : cursor.getString(0); size = cursor.isNull(1) ? 0 : cursor.getLong(1); } } String mime = resolver.getType(uri); return new FileRef(id, uri, name, size, mime == null ? "application/octet-stream" : mime); }
    private JSONObject message(String type) throws Exception { return new JSONObject().put("v", 1).put("type", type).put("seq", ++seq).put("ts", System.currentTimeMillis()).put("deviceId", deviceId); }
    private synchronized void sendJson(JSONObject json) throws IOException { output.write((json.toString() + "\n").getBytes(StandardCharsets.UTF_8)); output.flush(); }
    void close() { closed = true; connected = false; for (ReceiveFile f : receiving.values()) try { if (f.output != null) f.output.close(); } catch (IOException ignored) {} try { if (socket != null) socket.close(); } catch (IOException ignored) { } io.shutdownNow(); transferIo.shutdownNow(); }
    private static String reason(String value) { if ("need_pair".equals(value)) return "设备未配对，请在电脑端输入匹配码或扫码配对"; if ("bad_token".equals(value)) return "匹配凭证已失效，请重新配对"; if ("rejected".equals(value)) return "电脑端拒绝了连接"; return "连接被拒绝（" + value + "）"; }
    private static final class FileRef { final String id; final Uri uri; final String name, mime; final long size; FileRef(String id, Uri uri, String name, long size, String mime) { this.id = id; this.uri = uri; this.name = name; this.size = size; this.mime = mime; } }
    private static final class JSONObjectAuth { final String mode, code, token; JSONObjectAuth(String mode, String code, String token) { this.mode = mode; this.code = code; this.token = token; } }
    private static final class ReceiveFile { final String transferId, id, name; final long size; final Uri uri; final OutputStream output; long received; ReceiveFile(String transferId, String id, long size, String name, Uri uri, OutputStream output) { this.transferId = transferId; this.id = id; this.size = size; this.name = name; this.uri = uri; this.output = output; } }
}
