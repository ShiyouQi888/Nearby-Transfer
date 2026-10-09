package com.lantransfer.mobile;

import android.content.Context;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Resolves a short group code by discovering group hosts on the current LAN. */
final class GroupInviteResolver {
    interface Callback { void onResult(JSONObject invite, String error); }
    private GroupInviteResolver() { }

    static void resolve(Context context, String code, Callback callback) {
        new Thread(() -> {
            JSONObject found = null; String error = "没有找到群主设备";
            try (DatagramSocket udp = new DatagramSocket(null)) {
                udp.setReuseAddress(true); udp.bind(new InetSocketAddress(0)); udp.setBroadcast(true);
                String nonce = Long.toHexString(System.nanoTime()); byte[] request = new JSONObject().put("v",1).put("type","group-discover").put("nonce",nonce).toString().getBytes(StandardCharsets.UTF_8);
                udp.send(new DatagramPacket(request,request.length,InetAddress.getByName("255.255.255.255"),GroupHostService.DISCOVERY_PORT));
                int[] subnet = wifiSubnet(context); if(subnet!=null){int b=subnet[3]+1;byte[] addr={(byte)(b>>>24),(byte)(b>>>16),(byte)(b>>>8),(byte)b};try{udp.send(new DatagramPacket(request,request.length,InetAddress.getByAddress(addr),GroupHostService.DISCOVERY_PORT));}catch(Exception ignored){}}
                // The Android emulator is behind NAT: LAN broadcast does not reach the host PC.
                // 10.0.2.2 is its dedicated host-loopback alias; real devices never use this path.
                if (android.os.Build.HARDWARE.contains("ranchu") || android.os.Build.HARDWARE.contains("goldfish")) {
                    udp.send(new DatagramPacket(request,request.length,InetAddress.getByName("10.0.2.2"),GroupHostService.DISCOVERY_PORT));
                }
                Map<String,JSONObject> hosts=new LinkedHashMap<>(); long deadline=System.currentTimeMillis()+1200; byte[] buf=new byte[8192];
                while(System.currentTimeMillis()<deadline){udp.setSoTimeout((int)Math.max(1,deadline-System.currentTimeMillis()));DatagramPacket p=new DatagramPacket(buf,buf.length);try{udp.receive(p);}catch(java.net.SocketTimeoutException done){break;}
                    try{JSONObject packet=new JSONObject(new String(p.getData(),p.getOffset(),p.getLength(),StandardCharsets.UTF_8));if(packet.optInt("v")!=1||!"group-hosts".equals(packet.optString("type"))||!nonce.equals(packet.optString("nonce")))continue;JSONArray groups=packet.optJSONArray("groups");if(groups==null)continue;for(int i=0;i<groups.length();i++){JSONObject g=groups.optJSONObject(i);if(g!=null)hosts.put(p.getAddress().getHostAddress()+"/"+g.optString("groupId"),new JSONObject(g.toString()).put("host",p.getAddress().getHostAddress()));}}catch(Exception ignored){}
                }
                if(!hosts.isEmpty())error="口令无效或已过期，请确认输入正确";
                for(JSONObject host:hosts.values()){JSONObject invite=redeem(host,code);if(invite!=null){found=invite;break;}}
            } catch(Exception e){error=String.valueOf(e.getMessage());}
            JSONObject result=found;String reason=error;new android.os.Handler(android.os.Looper.getMainLooper()).post(()->callback.onResult(result,reason));
        },"group-code-resolver").start();
    }

    private static JSONObject redeem(JSONObject host,String code){
        try(Socket socket=new Socket()){
            socket.connect(new InetSocketAddress(host.getString("host"),host.optInt("port",GroupHostService.PORT)),1500);socket.setSoTimeout(1800);
            OutputStreamWriter writer=new OutputStreamWriter(socket.getOutputStream(),StandardCharsets.UTF_8);writer.write(new JSONObject().put("type","redeem").put("groupId",host.getString("groupId")).put("code",code).toString()+"\n");writer.flush();
            BufferedReader reader=new BufferedReader(new InputStreamReader(socket.getInputStream(),StandardCharsets.UTF_8));String line=reader.readLine();if(line==null||line.length()>16384)return null;
            JSONObject response=new JSONObject(line);if(!"invite".equals(response.optString("type")))return null;JSONObject invite=response.optJSONObject("invite");if(invite==null)return null;invite.put("host",host.getString("host"));return invite;
        }catch(Exception ignored){return null;}
    }
    private static int[] wifiSubnet(Context context){try{WifiManager wifi=(WifiManager)context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);DhcpInfo d=wifi==null?null:wifi.getDhcpInfo();if(d==null||d.ipAddress==0||d.netmask==0)return null;int ip=Integer.reverseBytes(d.ipAddress),mask=Integer.reverseBytes(d.netmask),network=ip&mask,broadcast=network|~mask;return new int[]{ip,Math.max(0,broadcast-network-1),network+1,broadcast-1};}catch(Exception e){return null;}}
}
