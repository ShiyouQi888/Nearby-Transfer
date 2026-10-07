package com.lantransfer.mobile;

import android.os.Build;
import android.content.Context;
import android.net.wifi.WifiManager;
import android.net.DhcpInfo;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Responds to the desktop LAN probe so the native app appears in network scans. */
final class NativeDiscovery {
    private static final int PORT = 53317;
    private final String deviceId;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private DatagramSocket socket;
    private Thread thread;
    private WifiManager.MulticastLock multicastLock;

    NativeDiscovery(String deviceId) { this.deviceId = deviceId; }

    interface ScanCallback { void onResult(Map<String, JSONObject> devices); }

    /** Sends a LAN probe and collects only announce packets received for this scan. */
    void scan(ScanCallback callback) {
        new Thread(() -> {
            Map<String, JSONObject> found = new LinkedHashMap<>();
            DatagramSocket probeSocket = null;
            try {
                probeSocket = new DatagramSocket(null);
                probeSocket.setReuseAddress(true);
                probeSocket.bind(new InetSocketAddress(0));
                probeSocket.setBroadcast(true);
                JSONObject probe = new JSONObject().put("v", 1).put("type", "probe").put("seq", System.nanoTime() & 0x7fffffff).put("ts", System.currentTimeMillis()).put("deviceId", deviceId).put("wantReply", true);
                byte[] payload = (probe.toString() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                probeSocket.send(new DatagramPacket(payload, payload.length, InetAddress.getByName("255.255.255.255"), PORT));
                probeSocket.send(new DatagramPacket(payload, payload.length, InetAddress.getByName("239.255.42.99"), PORT));
                // Also unicast within the current Wi-Fi subnet. Broadcast can be disabled by APs.
                int[] subnet = wifiSubnet();
                if (subnet != null) {
                    int broadcast = subnet[3] + 1;
                    byte[] broadcastAddress = new byte[]{(byte)(broadcast >>> 24), (byte)(broadcast >>> 16), (byte)(broadcast >>> 8), (byte)broadcast};
                    try { probeSocket.send(new DatagramPacket(payload, payload.length, InetAddress.getByAddress(broadcastAddress), PORT)); } catch (Exception ignored) { }
                }
                if (subnet != null && subnet[1] <= 4096) {
                    for (int host = subnet[2]; host <= subnet[3]; host++) {
                        if (host == subnet[0]) continue;
                        byte[] ip = new byte[]{(byte)(host >>> 24), (byte)(host >>> 16), (byte)(host >>> 8), (byte)host};
                        try { probeSocket.send(new DatagramPacket(payload, payload.length, InetAddress.getByAddress(ip), PORT)); } catch (Exception ignored) { }
                    }
                }
                long deadline = System.currentTimeMillis() + 1300;
                byte[] buffer = new byte[8192];
                while (System.currentTimeMillis() < deadline) {
                    probeSocket.setSoTimeout((int)Math.max(1, deadline - System.currentTimeMillis()));
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    try { probeSocket.receive(packet); } catch (java.net.SocketTimeoutException done) { break; }
                    try {
                        JSONObject msg = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), java.nio.charset.StandardCharsets.UTF_8));
                        JSONObject device = msg.optJSONObject("device");
                        if (!"announce".equals(msg.optString("type")) || device == null || deviceId.equals(device.optString("deviceId"))) continue;
                        device.put("ip", packet.getAddress().getHostAddress());
                        found.put(device.optString("deviceId", device.optString("ip")), device);
                    } catch (Exception ignored) { }
                }
            } catch (Exception ignored) { }
            finally { if (probeSocket != null) probeSocket.close(); }
            Map<String, JSONObject> result = found;
            android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
            main.post(() -> callback.onResult(result));
        }, "lan-active-scan").start();
    }

    /** Returns {localIPv4, hostCount, networkStart, networkEnd} from DHCP data. */
    private int[] wifiSubnet() {
        try {
            WifiManager wifi = (WifiManager) AppContextHolder.context.getSystemService(Context.WIFI_SERVICE);
            DhcpInfo dhcp = wifi == null ? null : wifi.getDhcpInfo();
            if (dhcp == null || dhcp.ipAddress == 0 || dhcp.netmask == 0) return null;
            int local = Integer.reverseBytes(dhcp.ipAddress), mask = Integer.reverseBytes(dhcp.netmask);
            int network = local & mask, broadcast = network | ~mask;
            int start = network + 1, end = broadcast - 1;
            return new int[]{local, Math.max(0, end - start + 1), start, end};
        } catch (Exception ignored) { return null; }
    }

    void start() {
        if (!running.compareAndSet(false, true)) return;
        try {
            WifiManager wifi = (WifiManager) AppContextHolder.context.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) { multicastLock = wifi.createMulticastLock("nearby-transfer-discovery"); multicastLock.setReferenceCounted(false); multicastLock.acquire(); }
        } catch (Exception ignored) { }
        thread = new Thread(() -> {
            try {
                // 明确绑定 IPv4，避免部分 Android 设备将通配地址解析成 IPv6，收不到电脑的 UDP 探测。
                socket = new DatagramSocket(null); socket.setReuseAddress(true);
                socket.bind(new java.net.InetSocketAddress(InetAddress.getByName("0.0.0.0"), PORT));
                socket.setBroadcast(true);
                byte[] buffer = new byte[8192];
                while (running.get()) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    socket.setSoTimeout(2500);
                    try { socket.receive(packet); } catch (java.net.SocketTimeoutException ignored) { announce(); continue; }
                    try {
                        JSONObject msg = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), java.nio.charset.StandardCharsets.UTF_8));
                        if (!"probe".equals(msg.optString("type"))) continue;
                        byte[] reply = announceJson().toString().concat("\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                        socket.send(new DatagramPacket(reply, reply.length, packet.getAddress(), packet.getPort()));
                    } catch (Exception ignored) { }
                }
            } catch (Exception ignored) { }
            finally { if (socket != null) socket.close(); socket = null; }
        }, "lan-discovery");
        thread.start();
    }

    void announceNow() { announce(); }

    private void announce() { try { byte[] data = announceJson().toString().concat("\n").getBytes(java.nio.charset.StandardCharsets.UTF_8); socket.send(new DatagramPacket(data, data.length, InetAddress.getByName("255.255.255.255"), PORT)); } catch (Exception ignored) { } }

    private JSONObject announceJson() throws Exception {
        String name = AppContextHolder.context.getSharedPreferences("nearby_transfer_identity", Context.MODE_PRIVATE).getString("device_name", "我的手机");
        return new JSONObject().put("v", 1).put("type", "announce").put("seq", System.nanoTime() & 0x7fffffff).put("ts", System.currentTimeMillis()).put("deviceId", deviceId)
            .put("device", new JSONObject().put("deviceId", deviceId).put("name", name).put("type", "mobile").put("os", "Android").put("port", PORT).put("protocol", "LTP/1").put("pairingRequired", true));
    }

    void stop() { running.set(false); if (socket != null) socket.close(); if (thread != null) thread.interrupt(); if (multicastLock != null && multicastLock.isHeld()) multicastLock.release(); }

    static final class AppContextHolder { static android.content.Context context; }
}
