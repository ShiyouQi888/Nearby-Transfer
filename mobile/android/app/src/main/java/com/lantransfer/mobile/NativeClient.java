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
import java.io.FileInputStream;
import java.io.RandomAccessFile;
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
    interface Listener { void onConnected(String serverName); void onError(String message); void onClosed(); void onProgress(int percent); default void onConnectionDetails(String serverName, String serverId, String token, String host) {} default void onRemoteAvatar(String avatarData) {} default void onRejected(String reason) {} default void onProgress(int percent, boolean receiving) { onProgress(percent); } default void onTransferFinished(boolean incoming, String label, boolean success) {} default void onSendWaiting(List<Uri> files) {} default void onSendAccepted(List<Uri> files) {} default void onSendFailed(List<Uri> files, String error) {} default void onSendRejected(List<Uri> files) {} default void onIncomingOffer(String label) {} default void onIncomingOffer(String label, String deviceName, String ip) { onIncomingOffer(label); }
        /**
         * 收到对端发来的聊天消息（文本或文件）。
         * @param fromSelf 留空/未使用；消息一定是「对方发来的」
         */
        default void onChatMessage(String msgId, long ts, String text, String fileName, long fileSize, String transferId) {}
        /** 自己发出的消息被对端确认送达 */
        default void onChatAck(String msgId, long ts) {}
        /** 对端已读到某个时间点之前的消息 */
        default void onChatRead(long upToTs) {}
        /** 聊天里发文件：接收方确认接收（含静默自动接收） */
        default void onChatFileAccepted(String transferId) {}
        /** 聊天里发文件：接收方拒绝 */
        default void onChatFileRejected(String transferId) {}
        default void onChatFileProgress(String transferId, int percent) {}
        default void onChatFileFinished(String transferId, boolean incoming, boolean success, Uri uri) {}
    }
    static final int PORT = 53317;
    static final int CHUNK_SIZE = 256 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService transferIo = Executors.newSingleThreadExecutor();
    private final ExecutorService chatIo = Executors.newSingleThreadExecutor();
    private final Listener listener; private final String deviceId; private final String deviceName; private final boolean english;
    private ContentResolver resolver; private List<FileRef> pendingFiles = new ArrayList<>(); private String pendingTransferId; private List<Uri> pendingSendUris = new ArrayList<>();
    // socket / output 必须 volatile：连接由 IO 线程建立并赋值，
    // 而聊天消息是从 UI 主线程写出的（用户点「发送」）。
    // 不加 volatile 会读到旧值（null 或上一会话的流），
    // 表现为「发出去了但对方永远收不到」——正是这个 bug 的根因。
    private volatile Socket socket; private volatile OutputStream output; private volatile boolean closed; private int seq;
    private volatile boolean connected;
    private String remoteDeviceName = "电脑";
    private String remoteIp = "未知";
    private String pendingFileNames = "";
    private byte[] receiveBuffer = new byte[0];
    private final java.util.Map<String, ReceiveFile> receiving = new java.util.concurrent.ConcurrentHashMap<>();
    private JSONObject pendingIncomingOffer;
    private String pendingIncomingLabel = "";
    /** 聊天专用：本端已授权「本会话静默接收」的对端 */
    private boolean chatSilentAccept = false;
    /** 聊天文件消息的 transferId -> 归属的 chat msgId，用于把传输进度挂回聊天气泡 */
    private final java.util.Map<String, String> chatTransferMsgIds = new java.util.concurrent.ConcurrentHashMap<>();
    /** 正在等待「聊天文件」接收确认的 transferId 集合（这些走静默/自动接收，不进传输页确认） */
    private final java.util.Set<String> chatOfferTransferIds = new java.util.HashSet<>();

    NativeClient(String deviceId, String deviceName, Listener listener, boolean english) { this.deviceId = deviceId; this.deviceName = deviceName; this.listener = listener; this.english = english; }

    void connect(String host, int port, String pairCode) {
        connectInternal(host, port, new JSONObjectAuth("pair", pairCode, null));
    }

    void connectWithQr(String host, int port, String token) {
        connectInternal(host, port, new JSONObjectAuth("pair", null, token));
    }

    void connectPaired(String host, int port, String token) {
        connectInternal(host, port, new JSONObjectAuth("paired", null, token));
    }

    boolean isConnected() { return connected && socket != null && socket.isConnected() && !socket.isClosed(); }

    void updateProfile() {
        try {
            String avatar = NativeDiscovery.AppContextHolder.context.getSharedPreferences("nearby_transfer_identity", android.content.Context.MODE_PRIVATE).getString("avatar_data", "");
            sendJson(message("profile_update").put("device", new JSONObject().put("deviceId", deviceId).put("name", deviceName).put("type", "mobile").put("os", "Android").put("avatarData", avatar)));
        } catch (Exception ignored) { }
    }

    private void connectInternal(String host, int port, JSONObjectAuth authData) {
        io.execute(() -> {
            try {
                socket = openSocket(host, port); remoteIp = socket.getInetAddress() == null ? host : socket.getInetAddress().getHostAddress(); output = socket.getOutputStream();
                JSONObject auth = new JSONObject().put("mode", authData.mode);
                if (authData.code != null) auth.put("pairCode", authData.code);
                if (authData.token != null) auth.put("token", authData.token);
                String avatar = NativeDiscovery.AppContextHolder.context.getSharedPreferences("nearby_transfer_identity", android.content.Context.MODE_PRIVATE).getString("avatar_data", "");
                sendJson(message("hello").put("device", new JSONObject().put("deviceId", deviceId).put("name", deviceName).put("type", "mobile").put("os", "Android").put("avatarData", avatar)).put("auth", auth));
                BufferedInputStream input = new BufferedInputStream(socket.getInputStream()); byte[] buffer = new byte[32 * 1024]; int count;
                while (!closed && (count = input.read(buffer)) != -1) feedIncoming(buffer, count);
                if (!closed) { failInterruptedTransfers(); listener.onClosed(); }
            } catch (Exception e) { connected = false; if (!closed) { failInterruptedTransfers(); listener.onError(friendlyError(host, port, e)); } }
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
        android.util.Log.d("LTP-TRACE", "in  " + line.substring(0, Math.min(160, line.length())));
        android.util.Log.d("LTP-TRACE", "in  " + line.substring(0, Math.min(200, line.length())));
        try { JSONObject msg = new JSONObject(line); String type = msg.optString("type");
            if ("hello_ack".equals(type)) { if (msg.optBoolean("accepted", false)) { connected = true; JSONObject server = msg.optJSONObject("server"); remoteDeviceName = server == null ? "电脑" : server.optString("name", "电脑"); listener.onConnected(remoteDeviceName); listener.onRemoteAvatar(server == null ? "" : server.optString("avatarData", "")); listener.onConnectionDetails(remoteDeviceName, server == null ? "" : server.optString("deviceId", ""), msg.optString("token", ""), remoteIp); } else listener.onError(reason(msg.optString("reason"))); }
            else if ("send_offer".equals(type)) prepareIncomingOffer(msg);
            else if ("send_reject".equals(type)) { if (pendingTransferId != null && pendingTransferId.equals(msg.optString("transferId"))) { String rejectedId = pendingTransferId; listener.onTransferFinished(false, pendingFileNames, false); if (chatTransferMsgIds.containsKey(rejectedId)) listener.onChatFileFinished(rejectedId, false, false, null); listener.onSendRejected(new ArrayList<>(pendingSendUris)); pendingFiles.clear(); pendingSendUris.clear(); pendingTransferId = null; pendingFileNames = ""; listener.onRejected(msg.optString("reason", "user_denied")); } }
            else if ("complete".equals(type)) finishIncomingFile(msg.optString("fileId"), msg.optString("path", ""));
            else if ("send_accept".equals(type)) transferIo.execute(() -> { try { sendPendingFiles(msg); } catch (Exception e) { failPendingSend(e); } });
            else if ("ping".equals(type)) sendJson(message("pong"));
            else if ("chat_send".equals(type)) handleChatSend(msg);
            else if ("profile_update".equals(type)) { JSONObject device = msg.optJSONObject("device"); listener.onRemoteAvatar(device == null ? "" : device.optString("avatarData", "")); }
            else if ("chat_ack".equals(type)) listener.onChatAck(msg.optString("msgId", ""), msg.optLong("ts", 0));
            else if ("chat_read".equals(type)) listener.onChatRead(msg.optLong("upToTs", 0));
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
                String fileId = new String(receiveBuffer, 6, idLen, StandardCharsets.UTF_8); int frameSeq = ((receiveBuffer[6 + idLen] & 255) << 24) | ((receiveBuffer[7 + idLen] & 255) << 16) | ((receiveBuffer[8 + idLen] & 255) << 8) | (receiveBuffer[9 + idLen] & 255); byte[] payload = new byte[payloadLen]; System.arraycopy(receiveBuffer, header, payload, 0, payloadLen); consume(header + payloadLen); receiveChunk(fileId, frameSeq, payload); continue;
            }
            int nl = -1; for (int i = 0; i < receiveBuffer.length; i++) if (receiveBuffer[i] == '\n') { nl = i; break; }
            if (nl < 0) return; String line = new String(receiveBuffer, 0, nl, StandardCharsets.UTF_8).trim(); consume(nl + 1); if (!line.isEmpty()) handleMessage(line);
        }
    }

    private void consume(int count) { byte[] rest = new byte[receiveBuffer.length - count]; System.arraycopy(receiveBuffer, count, rest, 0, rest.length); receiveBuffer = rest; }

    private synchronized void prepareIncomingOffer(JSONObject msg) throws Exception {
        String transferId = msg.optString("transferId"); JSONArray files = msg.optJSONArray("files"); if (files == null || files.length() == 0) return;

        // 聊天里发来的文件（origin=chat）：记录归属，并在已授权时静默接收，
        // 不再弹传输页的确认卡片——否则每条文件消息都会打断对话。
        if ("chat".equals(msg.optString("origin", ""))) {
            String chatMsgId = msg.optString("chatId", "");
            if (!chatMsgId.isEmpty()) chatTransferMsgIds.put(transferId, chatMsgId);
            long totalBytes = msg.optLong("totalBytes", 0);
            if (chatSilentAccept && files.length() <= CHAT_SILENT_MAX_FILES && totalBytes <= CHAT_SILENT_MAX_BYTES) {
                chatOfferTransferIds.add(transferId);
                final JSONObject auto = msg;
                transferIo.execute(() -> { try { acceptIncomingOfferNow(auto); } catch (Exception e) { listener.onError("自动接收失败：" + (e.getMessage() == null ? "无法创建文件" : e.getMessage())); } });
                return;
            }
        }

        pendingIncomingOffer = msg;
        StringBuilder names = new StringBuilder();
        int shown = Math.min(files.length(), 20);
        for (int i = 0; i < shown; i++) { JSONObject file = files.optJSONObject(i); if (file == null) continue; String name = file.optString("name", "文件").replaceAll("[\\r\\n]", " "); names.append("\n• ").append(name).append(" · ").append(android.text.format.Formatter.formatShortFileSize(NativeDiscovery.AppContextHolder.context, file.optLong("size", 0))); }
        if (files.length() > shown) names.append("\n… ").append(files.length() - shown).append(english ? " more files" : " 个文件未展开");
        String size = android.text.format.Formatter.formatShortFileSize(NativeDiscovery.AppContextHolder.context, msg.optLong("totalBytes", 0));
        String label = (english ? files.length() + " file(s) · " : files.length() + " 个文件 · ") + size + names; pendingIncomingLabel = label; listener.onIncomingOffer(label, remoteDeviceName, remoteIp);
    }

    // ─────────────────────────────────────────────────────────────
    // 聊天（Chat over LTP/1）
    // ─────────────────────────────────────────────────────────────

    /** 允许/禁止「本会话静默接收文件」。接收方在聊天页确认一次后置为 true。 */
    void setChatSilentAccept(boolean allowed) { chatSilentAccept = allowed; }
    boolean isChatSilentAccept() { return chatSilentAccept; }

    /** 该 transferId 是否属于聊天文件（用于把传输进度挂回聊天气泡）。 */
    String chatMsgIdForTransfer(String transferId) { return transferId == null ? null : chatTransferMsgIds.get(transferId); }
    boolean isChatTransfer(String transferId) { return transferId == null ? false : chatTransferMsgIds.containsKey(transferId); }

    /**
     * 发送一条聊天文本消息。返回本端生成的 msgId，供 UI 立即上屏。
     *
     * 注意：这里同步写出，不要改回 io.execute(...) 异步。
     * UI 依赖返回值立刻上屏（msgId 为 null 就不显示气泡），
     * 异步化会让「已发送」气泡的时序变得不可预测。
     * 跨线程可见性已由 socket/output 的 volatile 保证。
     */
    String sendChatText(String text) {
        if (text == null) return null;
        String trimmed = text.trim();
        if (trimmed.isEmpty()) return null;
        if (trimmed.length() > CHAT_TEXT_MAX) { listener.onError(english ? "Message too long (max " + CHAT_TEXT_MAX + ")" : "消息过长（最多 " + CHAT_TEXT_MAX + " 字）"); return null; }
        String msgId = makeMsgId();
        try {
            JSONObject payload = message("chat_send").put("msgId", msgId).put("kind", "text").put("text", trimmed);
            chatIo.execute(() -> {
                try { sendJson(payload); }
                catch (Exception e) { listener.onError(english ? "Failed to send message" : "消息发送失败"); }
            });
        } catch (Exception e) { listener.onError(english ? "Failed to send message" : "消息发送失败"); return null; }
        return msgId;
    }

    /**
     * 发送一条聊天文件消息：先发 chat_send（kind=file）建立气泡，
     * 再走标准 send_offer（origin=chat）完成传输。
     */
    String sendChatFile(ContentResolver resolver, Uri uri, String transferId) {
        if (resolver == null || uri == null) return null;
        String msgId = makeMsgId();
        if (transferId == null || transferId.isEmpty()) transferId = "t_a_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        final String chatTransferId = transferId;
        transferIo.execute(() -> {
            try {
                this.resolver = resolver;
                FileRef ref = inspect(resolver, uri, "f_1");
                if (!ref.sizeKnown) ref.size = measureSize(resolver, ref.uri);
                JSONArray files = new JSONArray();
                files.put(new JSONObject().put("fileId", ref.id).put("name", ref.name).put("size", ref.size).put("mime", ref.mime)
                        .put("relPath", ref.name).put("isDir", false).put("mtime", System.currentTimeMillis())
                        .put("chunkSize", CHUNK_SIZE).put("sha256", sha256(resolver, ref.uri)));
                pendingFiles.clear(); pendingFiles.add(ref);
                pendingSendUris = new ArrayList<>(); pendingSendUris.add(uri);
                pendingFileNames = ref.name; pendingTransferId = chatTransferId;
                chatTransferMsgIds.put(chatTransferId, msgId);

                sendJson(message("chat_send").put("msgId", msgId).put("kind", "file").put("transferId", chatTransferId)
                        .put("fileName", ref.name).put("fileSize", ref.size).put("mime", ref.mime));
                sendJson(message("send_offer").put("transferId", chatTransferId).put("origin", "chat").put("chatId", msgId)
                        .put("files", files).put("totalBytes", ref.size));
                listener.onProgress(0); listener.onChatFileProgress(chatTransferId, 0);
            } catch (Exception e) { listener.onError(english ? "Failed to send file" : "文件发送失败"); }
        });
        return msgId;
    }

    /** 回复 chat_read（对端消息我都看过了）。 */
    void sendChatRead(long upToTs) {
        try {
            JSONObject payload = message("chat_read").put("upToTs", upToTs);
            chatIo.execute(() -> { try { sendJson(payload); } catch (Exception ignored) { } });
        } catch (Exception ignored) { }
    }

    private void handleChatSend(JSONObject msg) {
        String msgId = msg.optString("msgId", "");
        String kind = msg.optString("kind", "text");
        String text = msg.optString("text", "");
        String fileName = msg.optString("fileName", "");
        long fileSize = msg.optLong("fileSize", 0);
        String transferId = msg.optString("transferId", "");
        JSONObject attachment = msg.optJSONObject("attachment");
        if (attachment != null) {
            if (transferId.isEmpty()) transferId = attachment.optString("transferId", "");
            JSONArray files = attachment.optJSONArray("files");
            JSONObject first = files == null ? null : files.optJSONObject(0);
            if (first != null) { if (fileName.isEmpty()) fileName = first.optString("name", ""); if (fileSize <= 0) fileSize = first.optLong("size", 0); }
        }
        if (!transferId.isEmpty() && !msgId.isEmpty()) chatTransferMsgIds.put(transferId, msgId);
        // 无论是否重复，都要回 ack——对端靠它把状态从「已发送」推进到「已送达」。
        try { sendJson(message("chat_ack").put("msgId", msgId).put("ts", msg.optLong("ts", System.currentTimeMillis()))); } catch (Exception ignored) { }
        listener.onChatMessage(msgId, msg.optLong("ts", System.currentTimeMillis()), text, fileName, fileSize, transferId);
    }

    private String makeMsgId() {
        String who = deviceId == null ? "mob" : deviceId.replaceAll("^[a-z]+-", "");
        if (who.length() > 6) who = who.substring(0, 6);
        return "m_" + who + "_" + System.currentTimeMillis() + "_" + Integer.toHexString(new java.util.Random().nextInt(0xffff));
    }

    /** 聊天静默接收阈值：单次不超过 20 个文件且不超过 500MB。 */
    static final int CHAT_SILENT_MAX_FILES = 20;
    static final long CHAT_SILENT_MAX_BYTES = 500L * 1024 * 1024;
    static final int CHAT_TEXT_MAX = 4000;

    void acceptIncomingOffer() {
        final JSONObject offer;
        synchronized (this) { offer = pendingIncomingOffer; pendingIncomingOffer = null; }
        if (offer == null) return;
        final String transferId = offer.optString("transferId");
        final JSONArray files = offer.optJSONArray("files");
        transferIo.execute(() -> {
            try {
                acceptIncomingOfferNow(offer);
                if (!transferId.isEmpty() && chatTransferMsgIds.containsKey(transferId)) listener.onChatFileAccepted(transferId);
            } catch (Exception e) { listener.onError("接收准备失败：" + (e.getMessage() == null ? "无法创建文件" : e.getMessage())); }
        });
    }

    void rejectIncomingOffer() {
        final JSONObject offer;
        synchronized (this) { offer = pendingIncomingOffer; pendingIncomingOffer = null; }
        if (offer == null) return;
        final String transferId = offer.optString("transferId");
        try {
            sendJson(message("send_reject").put("transferId", transferId).put("reason", "user_denied"));
            listener.onTransferFinished(true, pendingIncomingLabel, false); pendingIncomingLabel = "";
            if (!transferId.isEmpty() && chatTransferMsgIds.containsKey(transferId)) listener.onChatFileRejected(transferId);
        } catch (Exception e) { listener.onError("拒绝接收失败"); }
    }

    private void acceptIncomingOfferNow(JSONObject msg) throws Exception {
        String transferId = msg.optString("transferId"); JSONArray files = msg.optJSONArray("files");
        JSONArray resume = new JSONArray();
        String savePath = "下载/邻传";
        for (int i = 0; i < files.length(); i++) { JSONObject f = files.getJSONObject(i); String id = f.optString("fileId"); String name = safeName(f.optString("name", "file")); ReceiveFile rf = createReceiveFile(transferId, id, f.optLong("size", 0), name, f.optString("mime", "application/octet-stream"), f.optString("sha256", "")); receiving.put(id, rf); if (rf.received > 0) resume.put(new JSONObject().put("fileId", id).put("receivedBytes", rf.received)); }
        sendJson(message("send_accept").put("transferId", transferId).put("acceptedBy", deviceName).put("resume", resume).put("saveTo", savePath));
    }

    private ReceiveFile createReceiveFile(String transferId, String id, long size, String name, String mime, String sha256) throws IOException {
        File dir = new File(((MainActivity) listener).getFilesDir(), "incoming-parts"); if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建接收目录");
        String identity = sha256.isEmpty() ? id + "_" + name + "_" + size : sha256;
        File part = new File(dir, digestText(identity) + ".part");
        long received = part.isFile() ? Math.min(part.length(), Math.max(0, size)) : 0;
        received = received / CHUNK_SIZE * CHUNK_SIZE;
        try (RandomAccessFile trim = new RandomAccessFile(part, "rw")) { trim.setLength(received); }
        return new ReceiveFile(transferId, id, size, name, mime, sha256, Uri.fromFile(part), new FileOutputStream(part, true), received);
    }

    private void receiveChunk(String fileId, int frameSeq, byte[] payload) throws Exception { ReceiveFile f = receiving.get(fileId); if (f == null) return; f.output.write(payload); f.received += payload.length; f.ackedSeq = frameSeq; f.chunksSinceAck++; if (f.chunksSinceAck >= 4) { sendJson(message("chunk_ack").put("transferId", f.transferId).put("fileId", fileId).put("ackedSeq", f.ackedSeq).put("receivedBytes", f.received)); f.chunksSinceAck = 0; } if (f.size > 0) { int percent = (int) Math.min(99, f.received * 100L / f.size); listener.onProgress(percent, true); if (chatTransferMsgIds.containsKey(f.transferId)) listener.onChatFileProgress(f.transferId, percent); } }

    private void finishIncomingFile(String fileId, String path) throws Exception {
        ReceiveFile f = receiving.remove(fileId);
        if (f == null || f.output == null) return;
        f.output.flush(); f.output.close();
        File part = new File(f.uri.getPath());
        if (f.received != f.size) {
            listener.onError(english ? "Received file is incomplete; reconnect and accept again to resume" : "文件尚未接收完整；重新连接并再次接收即可续传");
            listener.onTransferFinished(true, f.name, false);
            if (chatTransferMsgIds.containsKey(f.transferId)) listener.onChatFileFinished(f.transferId, true, false, null);
            return;
        }
        if (!f.sha256.isEmpty()) {
            try {
                String actual = sha256(part);
                if (!f.sha256.equalsIgnoreCase(actual)) {
                    part.delete();
                    listener.onError(english ? "File verification failed; please resend the file" : "文件校验失败，请重新发送");
                    listener.onTransferFinished(true, f.name, false);
                    if (chatTransferMsgIds.containsKey(f.transferId)) listener.onChatFileFinished(f.transferId, true, false, null);
                    return;
                }
            } catch (Exception verificationError) {
                part.delete();
                listener.onError(english ? "Unable to verify the received file" : "无法验证接收文件完整性");
                listener.onTransferFinished(true, f.name, false);
                if (chatTransferMsgIds.containsKey(f.transferId)) listener.onChatFileFinished(f.transferId, true, false, null);
                return;
            }
        }
        if (f.chunksSinceAck > 0) sendJson(message("chunk_ack").put("transferId", f.transferId).put("fileId", fileId).put("ackedSeq", f.ackedSeq).put("receivedBytes", f.received));
        Uri destination = publishReceivedFile(part, f.name, f.mime);
        sendJson(message("complete").put("transferId", f.transferId).put("fileId", fileId).put("path", path.isEmpty() ? f.name : path).put("size", f.received));
        part.delete();
        listener.onProgress(100, true);
        listener.onTransferFinished(true, f.name, true);
        if (chatTransferMsgIds.containsKey(f.transferId)) listener.onChatFileFinished(f.transferId, true, true, destination);
    }

    private Uri publishReceivedFile(File part, String name, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= 29 && listener instanceof MainActivity) {
            ContentValues values = new ContentValues(); values.put(MediaStore.Downloads.DISPLAY_NAME, uniqueDownloadName(name)); values.put(MediaStore.Downloads.MIME_TYPE, mime); values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/邻传"); values.put(MediaStore.Downloads.IS_PENDING, 1);
            ContentResolver cr = ((MainActivity) listener).getContentResolver(); Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values); if (uri == null) throw new IOException("无法创建下载文件");
            try (InputStream input = new FileInputStream(part); OutputStream output = cr.openOutputStream(uri)) { if (output == null) throw new IOException("无法写入下载文件"); byte[] buffer = new byte[64 * 1024]; int count; while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count); }
            ContentValues ready = new ContentValues(); ready.put(MediaStore.Downloads.IS_PENDING, 0); cr.update(uri, ready, null, null); return uri;
        }
        File dir = new File(((MainActivity) listener).getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "received"); if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建下载目录"); File destination = uniqueFile(dir, name);
        try (InputStream input = new FileInputStream(part); OutputStream output = new FileOutputStream(destination)) { byte[] buffer = new byte[64 * 1024]; int count; while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count); }
        return Uri.fromFile(destination);
    }

    private static String uniqueDownloadName(String name) { return name; }
    private static String digestText(String value) { try { java.security.MessageDigest d = java.security.MessageDigest.getInstance("SHA-256"); byte[] bytes = d.digest(value.getBytes(StandardCharsets.UTF_8)); StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString(); } catch (Exception e) { return Integer.toHexString(value.hashCode()); } }
    private static String sha256(File file) throws Exception { java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256"); try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[64 * 1024]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); } StringBuilder result = new StringBuilder(); for (byte b : digest.digest()) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return result.toString(); }

    private static File uniqueFile(File dir, String name) { File candidate = new File(dir, name); if (!candidate.exists()) return candidate; String ext = "", base = name; int dot = name.lastIndexOf('.'); if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); } for (int i = 1; i < 10000; i++) { candidate = new File(dir, base + " (" + i + ")" + ext); if (!candidate.exists()) return candidate; } return new File(dir, base + " (" + System.currentTimeMillis() + ")" + ext); }

    private static String safeName(String name) { return name.replaceAll("[\\\\/:*?\"<>|]", "_"); }

    void sendFiles(ContentResolver resolver, List<Uri> uris) {
        transferIo.execute(() -> { try { JSONArray files = new JSONArray(); long total = 0; int index = 1; this.resolver = resolver; pendingFiles.clear(); pendingSendUris = new ArrayList<>(uris);
            StringBuilder names = new StringBuilder();
            for (Uri uri : uris) { FileRef ref = inspect(resolver, uri, "f_" + index++); if (!ref.sizeKnown) ref.size = measureSize(resolver, ref.uri); pendingFiles.add(ref); total += ref.size; if (names.length() > 0) names.append(", "); names.append(ref.name); files.put(new JSONObject().put("fileId", ref.id).put("name", ref.name).put("size", ref.size).put("mime", ref.mime).put("relPath", ref.name).put("isDir", false).put("mtime", System.currentTimeMillis()).put("chunkSize", CHUNK_SIZE).put("sha256", sha256(resolver, ref.uri))); }
            pendingFileNames = names.toString();
            pendingTransferId = "t_a_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
            sendJson(message("send_offer").put("transferId", pendingTransferId).put("files", files).put("totalBytes", total)); listener.onProgress(0); listener.onSendWaiting(new ArrayList<>(pendingSendUris));
        } catch (Exception e) { failPendingSend(e); } });
    }

    private void sendPendingFiles(JSONObject accept) throws Exception {
        if (resolver == null || pendingFiles.isEmpty() || pendingTransferId == null) return;
        listener.onSendAccepted(new ArrayList<>(pendingSendUris));
        JSONArray resume = accept.optJSONArray("resume"); long completed = 0; long total = 0;
        for (FileRef f : pendingFiles) total += f.size;
        for (FileRef f : pendingFiles) {
            long start = 0;
            if (resume != null) for (int i = 0; i < resume.length(); i++) { JSONObject r = resume.optJSONObject(i); if (r != null && f.id.equals(r.optString("fileId"))) start = Math.max(0, Math.min(f.size, r.optLong("receivedBytes", 0))); }
            completed += sendFile(f, start, total, completed);
            sendJson(message("complete").put("transferId", pendingTransferId).put("fileId", f.id).put("path", f.name).put("size", f.size));
        }
        String finishedTransferId = pendingTransferId;
        Uri sourceUri = pendingSendUris.isEmpty() ? null : pendingSendUris.get(0);
        listener.onProgress(100); listener.onTransferFinished(false, pendingFileNames, true);
        if (finishedTransferId != null && chatTransferMsgIds.containsKey(finishedTransferId)) listener.onChatFileFinished(finishedTransferId, false, true, sourceUri);
        pendingFiles.clear(); pendingSendUris.clear(); pendingTransferId = null; pendingFileNames = "";
    }

    private void failPendingSend(Exception error) {
        String message = error.getMessage() == null ? "发送失败" : error.getMessage();
        String failedTransferId = pendingTransferId;
        List<Uri> failed = new ArrayList<>(pendingSendUris);
        if (!failed.isEmpty()) listener.onSendFailed(failed, message);
        if (!pendingFileNames.isEmpty()) listener.onTransferFinished(false, pendingFileNames, false);
        if (failedTransferId != null && chatTransferMsgIds.containsKey(failedTransferId)) listener.onChatFileFinished(failedTransferId, false, false, null);
        pendingFiles.clear(); pendingSendUris.clear(); pendingTransferId = null; pendingFileNames = "";
        listener.onError(message);
    }

    private long sendFile(FileRef file, long start, long total, long completed) throws Exception {
        try (InputStream input = resolver.openInputStream(file.uri)) {
            if (input == null) throw new IOException("无法读取文件：" + file.name);
            long skipped = 0; while (skipped < start) { long n = input.skip(start - skipped); if (n <= 0) break; skipped += n; }
            byte[] chunk = new byte[CHUNK_SIZE]; int seq = (int) (start / CHUNK_SIZE); long sent = start; int count;
            while (!closed && (count = readChunk(input, chunk)) > 0) { sendBinary(encodeFrame(file.id, seq++, chunk, count)); sent += count; int percent = (int) Math.min(99, ((completed + sent) * 100L) / Math.max(1, total)); listener.onProgress(percent); if (pendingTransferId != null && chatTransferMsgIds.containsKey(pendingTransferId)) listener.onChatFileProgress(pendingTransferId, percent); }
            return sent;
        }
    }

    private static int readChunk(InputStream input, byte[] buffer) throws IOException { int total = 0, n; while (total < buffer.length && (n = input.read(buffer, total, buffer.length - total)) > 0) total += n; return total; }
    private synchronized void sendBinary(byte[] bytes) throws IOException { sendRaw(bytes); }

    /** 统一的写出出口：先校验流可用，避免「静默写进空流」。 */
    private void sendRaw(byte[] bytes) throws IOException {
        OutputStream out = output;
        if (out == null || socket == null || socket.isClosed() || !socket.isConnected()) {
            throw new IOException(english ? "Not connected" : "尚未连接到电脑");
        }
        out.write(bytes);
        out.flush();
    }
    private static byte[] encodeFrame(String fileId, int seq, byte[] payload, int length) { byte[] id = fileId.getBytes(StandardCharsets.UTF_8); byte[] frame = new byte[14 + id.length + length]; frame[0] = 'L'; frame[1] = 'T'; frame[2] = 'P'; frame[3] = 'C'; frame[4] = (byte) (id.length >>> 8); frame[5] = (byte) id.length; System.arraycopy(id, 0, frame, 6, id.length); int o = 6 + id.length; frame[o] = (byte) (seq >>> 24); frame[o + 1] = (byte) (seq >>> 16); frame[o + 2] = (byte) (seq >>> 8); frame[o + 3] = (byte) seq; frame[o + 4] = (byte) (length >>> 24); frame[o + 5] = (byte) (length >>> 16); frame[o + 6] = (byte) (length >>> 8); frame[o + 7] = (byte) length; System.arraycopy(payload, 0, frame, o + 8, length); return frame; }

    private FileRef inspect(ContentResolver resolver, Uri uri, String id) throws Exception { String name = "文件"; long size = 0; boolean sizeKnown = false; try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) { if (cursor != null && cursor.moveToFirst()) { name = cursor.getString(0) == null ? name : cursor.getString(0); if (!cursor.isNull(1)) { size = cursor.getLong(1); sizeKnown = true; } } } String mime = resolver.getType(uri); return new FileRef(id, uri, name, size, sizeKnown, mime == null ? "application/octet-stream" : mime); }
    private static long measureSize(ContentResolver resolver, Uri uri) throws IOException { try (InputStream input = resolver.openInputStream(uri)) { if (input == null) throw new IOException("无法读取文件"); byte[] buffer = new byte[64 * 1024]; long size = 0; int count; while ((count = input.read(buffer)) != -1) size += count; return size; } }
    private static String sha256(ContentResolver resolver, Uri uri) throws Exception { java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256"); try (InputStream input = resolver.openInputStream(uri)) { if (input == null) throw new IOException("无法读取文件"); byte[] buffer = new byte[64 * 1024]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); } StringBuilder result = new StringBuilder(); for (byte b : digest.digest()) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return result.toString(); }
    private JSONObject message(String type) throws Exception { return new JSONObject().put("v", 1).put("type", type).put("seq", ++seq).put("ts", System.currentTimeMillis()).put("deviceId", deviceId); }
    private synchronized void sendJson(JSONObject json) throws IOException { android.util.Log.d("LTP-TRACE", "out " + json.optString("type")); sendRaw((json.toString() + "\n").getBytes(StandardCharsets.UTF_8)); }
    private void failInterruptedTransfers() {
        if (!pendingFiles.isEmpty()) { listener.onTransferFinished(false, pendingFileNames, false); pendingFiles.clear(); pendingTransferId = null; pendingFileNames = ""; }
        for (ReceiveFile f : new ArrayList<>(receiving.values())) { try { if (f.output != null) f.output.close(); } catch (IOException ignored) { } listener.onTransferFinished(true, f.name, false); }
        receiving.clear(); pendingIncomingOffer = null; pendingIncomingLabel = "";
    }

    void close() { android.util.Log.d("LTP-TRACE", "close() called, stack=" + android.util.Log.getStackTraceString(new Throwable()).substring(0, Math.min(600, android.util.Log.getStackTraceString(new Throwable()).length()))); closed = true; connected = false; try { if (socket != null) socket.close(); } catch (IOException ignored) { } io.shutdownNow(); transferIo.shutdownNow(); chatIo.shutdownNow(); failInterruptedTransfers(); }
    private String reason(String value) { if ("need_pair".equals(value)) return english ? "Device is not paired. Enter the pairing code on the computer." : "设备未配对，请在电脑端输入匹配码或扫码配对"; if ("bad_token".equals(value)) return english ? "Pairing token expired. Please pair again." : "匹配凭证已失效，请重新配对"; if ("rejected".equals(value)) return english ? "The computer rejected the connection." : "电脑端拒绝了连接"; return english ? "Connection rejected (" + value + ")" : "连接被拒绝（" + value + "）"; }
    private static final class FileRef { final String id; final Uri uri; final String name, mime; long size; final boolean sizeKnown; FileRef(String id, Uri uri, String name, long size, boolean sizeKnown, String mime) { this.id = id; this.uri = uri; this.name = name; this.size = size; this.sizeKnown = sizeKnown; this.mime = mime; } }
    private static final class JSONObjectAuth { final String mode, code, token; JSONObjectAuth(String mode, String code, String token) { this.mode = mode; this.code = code; this.token = token; } }
    private static final class ReceiveFile { final String transferId, id, name, mime, sha256; final long size; final Uri uri; final OutputStream output; long received; int ackedSeq = -1, chunksSinceAck; ReceiveFile(String transferId, String id, long size, String name, String mime, String sha256, Uri uri, OutputStream output, long received) { this.transferId = transferId; this.id = id; this.size = size; this.name = name; this.mime = mime; this.sha256 = sha256; this.uri = uri; this.output = output; this.received = received; this.ackedSeq = (int)(received / CHUNK_SIZE) - 1; } }
}
