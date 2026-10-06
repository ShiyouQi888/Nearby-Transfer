package com.lantransfer.mobile;

import android.os.Build;
import android.content.Context;
import android.net.wifi.WifiManager;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
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

    private void announce() { try { byte[] data = announceJson().toString().concat("\n").getBytes(java.nio.charset.StandardCharsets.UTF_8); socket.send(new DatagramPacket(data, data.length, InetAddress.getByName("255.255.255.255"), PORT)); } catch (Exception ignored) { } }

    private JSONObject announceJson() throws Exception {
        return new JSONObject().put("v", 1).put("type", "announce").put("seq", System.nanoTime() & 0x7fffffff).put("ts", System.currentTimeMillis()).put("deviceId", deviceId)
            .put("device", new JSONObject().put("deviceId", deviceId).put("name", "我的手机").put("type", "mobile").put("os", "Android").put("port", PORT).put("protocol", "LTP/1").put("pairingRequired", true));
    }

    void stop() { running.set(false); if (socket != null) socket.close(); if (thread != null) thread.interrupt(); if (multicastLock != null && multicastLock.isHeld()) multicastLock.release(); }

    static final class AppContextHolder { static android.content.Context context; }
}
