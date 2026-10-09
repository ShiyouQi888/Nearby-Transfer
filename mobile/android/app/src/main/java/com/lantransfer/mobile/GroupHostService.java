package com.lantransfer.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.net.wifi.WifiManager;
import android.content.pm.ServiceInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Set;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Keeps phone-hosted LAN groups reachable while the app is backgrounded. */
public final class GroupHostService extends Service {
    static final int PORT = 53318;
    static final int DISCOVERY_PORT = 53300;
    static final String ACTION_START = "com.lantransfer.mobile.GROUP_HOST_START";
    static final String ACTION_SEND = "com.lantransfer.mobile.GROUP_HOST_SEND";
    static final String ACTION_FILE = "com.lantransfer.mobile.GROUP_HOST_FILE";
    static final String ACTION_REMOVE = "com.lantransfer.mobile.GROUP_HOST_REMOVE";
    static final String ACTION_DISSOLVE = "com.lantransfer.mobile.GROUP_HOST_DISSOLVE";
    static final String ACTION_LEAVE = "com.lantransfer.mobile.GROUP_HOST_LEAVE";
    static volatile Listener listener;
    interface Listener { void onGroupEvent(JSONObject event); }

    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Set<Peer> peers = ConcurrentHashMap.newKeySet();
    private final Map<String,long[]> redeemAttempts = new ConcurrentHashMap<>();
    private volatile ServerSocket serverSocket;
    private volatile java.net.DatagramSocket discoverySocket;
    private volatile boolean stopping;
    private GroupStore store;
    private PowerManager.WakeLock cpuLock;
    private WifiManager.WifiLock wifiLock;

    static void start(Context context) {
        Intent i = new Intent(context, GroupHostService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i); else context.startService(i);
    }
    static void sendLocal(Context context, String groupId, String text) {
        context.startService(new Intent(context, GroupHostService.class).setAction(ACTION_SEND).putExtra("groupId", groupId).putExtra("text", text));
    }
    static void sendFileMessage(Context context, JSONObject message) {
        context.startService(new Intent(context, GroupHostService.class).setAction(ACTION_FILE).putExtra("message", message.toString()));
    }
    static void removeMember(Context context,String groupId,String deviceId){context.startService(new Intent(context,GroupHostService.class).setAction(ACTION_REMOVE).putExtra("groupId",groupId).putExtra("deviceId",deviceId));}
    static void dissolve(Context context,String groupId){context.startService(new Intent(context,GroupHostService.class).setAction(ACTION_DISSOLVE).putExtra("groupId",groupId));}
    static void leave(Context context,String groupId){context.startService(new Intent(context,GroupHostService.class).setAction(ACTION_LEAVE).putExtra("groupId",groupId));}

    @Override public void onCreate() {
        super.onCreate(); store = new GroupStore(this); createChannel();
        if(Build.VERSION.SDK_INT>=29)startForeground(53318,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);else startForeground(53318,notification());
        acquireNetworkLocks();
        io.execute(this::listen); io.execute(this::listenForGroupDiscovery);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_SEND.equals(intent.getAction())) sendLocalMessage(intent.getStringExtra("groupId"), intent.getStringExtra("text"));
        else if (intent != null && ACTION_FILE.equals(intent.getAction())) sendLocalFileMessage(intent.getStringExtra("message"));
        else if(intent!=null&&ACTION_REMOVE.equals(intent.getAction())){JSONObject g=store.get(intent.getStringExtra("groupId"));if(g!=null&&g.optString("ownerId").equals(deviceId()))removeMember(g,intent.getStringExtra("deviceId"));}
        else if(intent!=null&&ACTION_DISSOLVE.equals(intent.getAction())){dissolve(intent.getStringExtra("groupId"));stopIfNoHostedGroups();}
        else if(intent!=null&&ACTION_LEAVE.equals(intent.getAction()))store.remove(intent.getStringExtra("groupId"));
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { stopping = true; try { if(serverSocket!=null)serverSocket.close(); } catch(Exception ignored){} try{if(discoverySocket!=null)discoverySocket.close();}catch(Exception ignored){} for(Peer p:peers)close(p); io.shutdownNow(); try{if(wifiLock!=null&&wifiLock.isHeld())wifiLock.release();}catch(Exception ignored){} try{if(cpuLock!=null&&cpuLock.isHeld())cpuLock.release();}catch(Exception ignored){} super.onDestroy(); }

    private void acquireNetworkLocks(){
        try{PowerManager pm=(PowerManager)getSystemService(POWER_SERVICE);if(pm!=null){cpuLock=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"NearbyTransfer:GroupHost");cpuLock.setReferenceCounted(false);cpuLock.acquire();}}catch(Exception ignored){}
        try{WifiManager wifi=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);if(wifi!=null){wifiLock=wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,"NearbyTransfer:GroupHostWifi");wifiLock.setReferenceCounted(false);wifiLock.acquire();}}catch(Exception ignored){}
    }

    private void createChannel() {
        if(Build.VERSION.SDK_INT>=26){NotificationManager nm=getSystemService(NotificationManager.class);nm.createNotificationChannel(new NotificationChannel("group_host","群聊在线服务",NotificationManager.IMPORTANCE_LOW));}
    }
    private Notification notification() {
        Intent open=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags=PendingIntent.FLAG_UPDATE_CURRENT|(Build.VERSION.SDK_INT>=23?PendingIntent.FLAG_IMMUTABLE:0);
        PendingIntent pi=PendingIntent.getActivity(this,53318,open,flags);
        Notification.Builder b=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,"group_host"):new Notification.Builder(this);
        return b.setSmallIcon(com.lantransfer.mobile.R.mipmap.ic_launcher).setContentTitle("邻传群聊在线").setContentText("群聊主持服务运行中，设备可在后台接收消息").setContentIntent(pi).setOngoing(true).build();
    }
    private void listen() {
        try { ServerSocket ss=new ServerSocket(PORT); serverSocket=ss; while(!stopping){ Socket socket=ss.accept(); socket.setTcpNoDelay(true); io.execute(()->serve(socket)); } }
        catch(Exception e){ if(!stopping)emit(event("error", "message", String.valueOf(e.getMessage()))); }
    }
    private void listenForGroupDiscovery(){
        try(java.net.DatagramSocket udp=new java.net.DatagramSocket(null)){discoverySocket=udp;udp.setReuseAddress(true);udp.bind(new java.net.InetSocketAddress("0.0.0.0",DISCOVERY_PORT));udp.setBroadcast(true);byte[] buffer=new byte[4096];while(!stopping){java.net.DatagramPacket packet=new java.net.DatagramPacket(buffer,buffer.length);try{udp.receive(packet);}catch(Exception e){if(stopping)break;continue;}try{JSONObject request=new JSONObject(new String(packet.getData(),packet.getOffset(),packet.getLength(),StandardCharsets.UTF_8));if(request.optInt("v")!=1||!"group-discover".equals(request.optString("type")))continue;JSONArray hosted=new JSONArray();for(JSONObject g:store.list())if(deviceId().equals(g.optString("ownerId"))&&g.optLong("inviteExpiresAt")>System.currentTimeMillis())hosted.put(new JSONObject().put("groupId",g.optString("id")).put("name",g.optString("name")).put("ownerName",g.optString("ownerName")).put("port",PORT));JSONObject response=new JSONObject().put("v",1).put("type","group-hosts").put("nonce",request.optString("nonce")).put("groups",hosted);byte[] payload=response.toString().getBytes(StandardCharsets.UTF_8);udp.send(new java.net.DatagramPacket(payload,payload.length,packet.getAddress(),packet.getPort()));}catch(Exception ignored){}}}catch(Exception e){if(!stopping)emit(event("error","message",String.valueOf(e.getMessage())));}
    }
    private void serve(Socket socket) {
        Peer peer=new Peer(socket); peers.add(peer);
        try {
            peer.reader=new BufferedReader(new InputStreamReader(socket.getInputStream(),StandardCharsets.UTF_8));
            peer.writer=new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(),StandardCharsets.UTF_8));
            String line; while(!stopping && (line=peer.reader.readLine())!=null){ if(line.length()>16384)break; JSONObject msg=new JSONObject(line); handle(peer,msg); }
        } catch(Exception ignored) { } finally { peers.remove(peer); close(peer); }
    }
    private void handle(Peer peer, JSONObject msg) throws Exception {
        if(peer.groupId.isEmpty()){
            if("redeem".equals(msg.optString("type"))){if(!allowRedeem(peer.socket.getInetAddress().getHostAddress())){write(peer,new JSONObject().put("type","error").put("reason","rate_limited"));close(peer);return;}String code=msg.optString("code"),requestedId=msg.optString("groupId");JSONObject g=requestedId.isEmpty()?findGroupByCode(code):store.get(requestedId);if(g==null||!deviceId().equals(g.optString("ownerId"))||g.optLong("inviteExpiresAt")<System.currentTimeMillis()||!constantTime(g.optString("inviteCode"),code)){write(peer,new JSONObject().put("type","error").put("reason","invalid_code"));close(peer);return;}JSONObject invite=new JSONObject().put("scheme","nearby-group-v1").put("groupId",g.optString("id")).put("name",g.optString("name")).put("ownerId",g.optString("ownerId")).put("ownerName",g.optString("ownerName")).put("port",PORT).put("token",g.optString("token"));write(peer,new JSONObject().put("type","invite").put("invite",invite));close(peer);return;}
            if(!"join".equals(msg.optString("type")))throw new IllegalArgumentException("join required");
            JSONObject group=store.get(msg.optString("groupId"));
            if(group==null||!constantTime(group.optString("token"),msg.optString("token"))||isBanned(group,msg.optString("deviceId"))){write(peer,new JSONObject().put("type","error").put("reason","invite_invalid"));return;}
            peer.groupId=group.optString("id"); peer.deviceId=msg.optString("deviceId"); peer.name=msg.optString("name",peer.deviceId); peer.deviceType=msg.optString("deviceType","desktop"); peer.avatarData=msg.optString("avatarData","");
            if(peer.deviceId.isEmpty())throw new IllegalArgumentException("deviceId required");
            JSONArray members=group.optJSONArray("members");if(members==null)members=new JSONArray();boolean found=false;
            for(int i=0;i<members.length();i++)if(peer.deviceId.equals(members.optJSONObject(i).optString("deviceId")))found=true;
            String avatarData=peer.avatarData;
            if(!found)members.put(new JSONObject().put("deviceId",peer.deviceId).put("name",peer.name).put("type",peer.deviceType).put("avatarData",avatarData).put("joinedAt",System.currentTimeMillis()));
            else for(int i=0;i<members.length();i++){JSONObject member=members.optJSONObject(i);if(member!=null&&peer.deviceId.equals(member.optString("deviceId"))){member.put("name",peer.name).put("type",peer.deviceType).put("avatarData",avatarData);break;}}
            store.setMembers(peer.groupId,members); group=store.get(peer.groupId);
            JSONObject publicGroup=new JSONObject(group.toString());publicGroup.remove("token");publicGroup.remove("inviteCode");publicGroup.remove("inviteExpiresAt");
            write(peer,new JSONObject().put("type","joined").put("group",publicGroup)); broadcast(peer.groupId,new JSONObject().put("type","members").put("groupId",peer.groupId).put("members",members));
            emit(new JSONObject().put("kind","group:members").put("groupId",peer.groupId).put("members",members)); return;
        }
        JSONObject group=store.get(peer.groupId); if(group==null)return;
        if(!peer.groupId.equals(msg.optString("groupId")))return;
        String type=msg.optString("type");
        if("message".equals(type)){
            String text=msg.optString("text").trim();if(text.isEmpty()||text.length()>4000)return;
            JSONObject rec=new JSONObject().put("msgId",msg.optString("msgId",java.util.UUID.randomUUID().toString())).put("senderId",peer.deviceId).put("senderName",peer.name).put("text",text).put("ts",System.currentTimeMillis());
            rec=store.append(peer.groupId,rec,true); if(rec!=null){JSONObject e=new JSONObject().put("type","message").put("groupId",peer.groupId).put("message",rec);broadcast(peer.groupId,e);emit(new JSONObject().put("kind","group:message").put("groupId",peer.groupId).put("message",rec));}
        }else if("file_start".equals(type)||"file_chunk".equals(type)||"file_end".equals(type)){
            if("file_chunk".equals(type)&&msg.optString("data").isEmpty())return;
            JSONObject value=new JSONObject(msg.toString()).put("groupId",peer.groupId).put("senderId",peer.deviceId).put("senderName",peer.name);
            if("file_start".equals(type)){value.put("name",msg.optString("name","文件")).put("size",Math.max(0,msg.optLong("size",0))).put("mime",msg.optString("mime","application/octet-stream"));}
            broadcast(peer.groupId,value);emit(new JSONObject(value.toString()).put("kind","group:file"));
        }else if("leave".equals(type)){JSONArray old=group.optJSONArray("members"),next=new JSONArray();if(old!=null)for(int i=0;i<old.length();i++){JSONObject m=old.optJSONObject(i);if(m!=null&&!peer.deviceId.equals(m.optString("deviceId")))next.put(m);}store.setMembers(peer.groupId,next);broadcast(peer.groupId,new JSONObject().put("type","members").put("groupId",peer.groupId).put("members",next));close(peer);}
    }
    private void sendLocalFileMessage(String raw){
        try{
            JSONObject msg=new JSONObject(raw==null?"":raw); String id=msg.optString("groupId"); JSONObject group=store.get(id);
            if(group==null||!deviceId().equals(group.optString("ownerId")))return;
            String type=msg.optString("type"); if(!"file_start".equals(type)&&!"file_chunk".equals(type)&&!"file_end".equals(type))return;
            JSONObject value=new JSONObject(msg.toString()).put("groupId",id).put("senderId",deviceId()).put("senderName",deviceName());
            broadcast(id,value); emit(new JSONObject(value.toString()).put("kind","group:file"));
        }catch(Exception ignored){}
    }
    private void sendLocalMessage(String groupId,String text){try{JSONObject g=store.get(groupId);if(g==null||!g.optString("ownerId").equals(deviceId()))return;String value=text==null?"":text.trim();if(value.isEmpty()||value.length()>4000)return;JSONObject rec=new JSONObject().put("msgId",java.util.UUID.randomUUID().toString()).put("senderId",deviceId()).put("senderName",deviceName()).put("text",value).put("ts",System.currentTimeMillis());rec=store.append(groupId,rec);if(rec!=null){JSONObject e=new JSONObject().put("type","message").put("groupId",groupId).put("message",rec);broadcast(groupId,e);emit(new JSONObject().put("kind","group:message").put("groupId",groupId).put("message",rec));}}catch(Exception ignored){}}
    private void removeMember(JSONObject group,String target){try{if(target.isEmpty()||target.equals(group.optString("ownerId")))return;JSONArray old=group.optJSONArray("members"),next=new JSONArray();if(old!=null)for(int i=0;i<old.length();i++){JSONObject m=old.optJSONObject(i);if(m!=null&&!target.equals(m.optString("deviceId")))next.put(m);}store.ban(group.optString("id"),target);store.setMembers(group.optString("id"),next);for(Peer p:peers)if(group.optString("id").equals(p.groupId)&&target.equals(p.deviceId)){write(p,new JSONObject().put("type","removed").put("groupId",p.groupId));close(p);}broadcast(group.optString("id"),new JSONObject().put("type","members").put("groupId",group.optString("id")).put("members",next));emit(new JSONObject().put("kind","group:members").put("groupId",group.optString("id")).put("members",next));}catch(Exception ignored){}}
    private void dissolve(String id){try{broadcast(id,new JSONObject().put("type","dissolved").put("groupId",id));store.dissolve(id);for(Peer p:peers)if(id.equals(p.groupId))close(p);emit(new JSONObject().put("kind","group:dissolved").put("groupId",id));}catch(Exception ignored){}}
    private void stopIfNoHostedGroups(){for(JSONObject g:store.list())if(deviceId().equals(g.optString("ownerId")))return;stopForeground(true);stopSelf();}
    private void broadcast(String id,JSONObject msg){for(Peer p:peers)if(id.equals(p.groupId))write(p,msg);}
    private void write(Peer p,JSONObject msg){try{synchronized(p){p.writer.write(msg.toString());p.writer.write("\n");p.writer.flush();}}catch(Exception ignored){close(p);}}
    private void close(Peer p){try{p.socket.close();}catch(Exception ignored){}}
    private void emit(JSONObject event){Listener l=listener;if(l!=null)l.onGroupEvent(event);}
    private JSONObject event(String kind,String key,String value){try{return new JSONObject().put("kind",kind).put(key,value);}catch(Exception e){return new JSONObject();}}
    private String deviceId(){return getSharedPreferences("nearby_transfer_identity",MODE_PRIVATE).getString("device_id","");}
    private String deviceName(){return getSharedPreferences("nearby_transfer_identity",MODE_PRIVATE).getString("device_name","我的手机");}
    private JSONObject findGroupByCode(String code){for(JSONObject g:store.list())if(deviceId().equals(g.optString("ownerId"))&&g.optLong("inviteExpiresAt")>=System.currentTimeMillis()&&constantTime(g.optString("inviteCode"),code))return g;return null;}
    private boolean constantTime(String a,String b){return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8),b.getBytes(StandardCharsets.UTF_8));}
    private boolean isBanned(JSONObject group,String id){JSONArray a=group.optJSONArray("bannedIds");if(a==null)return false;for(int i=0;i<a.length();i++)if(id.equals(a.optString(i)))return true;return false;}
    private synchronized boolean allowRedeem(String ip){long now=System.currentTimeMillis();long[] row=redeemAttempts.get(ip);if(row==null||now-row[1]>60000){row=new long[]{0,now};redeemAttempts.put(ip,row);}if(row[0]>=12)return false;row[0]++;return true;}
    private static final class Peer{final Socket socket;BufferedReader reader;BufferedWriter writer;String groupId="",deviceId="",name="",deviceType="mobile",avatarData="";Peer(Socket s){socket=s;}}
}
