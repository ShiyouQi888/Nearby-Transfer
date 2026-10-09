package com.lantransfer.mobile;

import org.json.JSONObject;
import android.content.ContentResolver;
import android.net.Uri;
import android.util.Base64;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A single direct TCP membership connection to a group's hosting device. */
final class GroupClient {
    interface Listener { void onEvent(JSONObject event); }
    private final JSONObject invite; private final String deviceId,name,avatarData; private final Listener listener;
    private final ExecutorService io=Executors.newSingleThreadExecutor(); private final ExecutorService writerIo=Executors.newSingleThreadExecutor(); private volatile Socket socket; private volatile BufferedWriter writer; private volatile boolean closed; private volatile boolean online;
    GroupClient(JSONObject invite,String deviceId,String name,String avatarData,Listener listener){this.invite=invite;this.deviceId=deviceId;this.name=name;this.avatarData=avatarData==null?"":avatarData;this.listener=listener;}
    void connect(){io.execute(()->{long delay=1000;while(!closed){boolean joined=false;try{Socket s=new Socket();socket=s;s.setTcpNoDelay(true);s.connect(new InetSocketAddress(invite.getString("host"),invite.optInt("port",GroupHostService.PORT)),8000);writer=new BufferedWriter(new OutputStreamWriter(s.getOutputStream(),StandardCharsets.UTF_8));send(new JSONObject().put("type","join").put("groupId",groupId()).put("token",invite.getString("token")).put("deviceId",deviceId).put("name",name).put("deviceType","mobile").put("avatarData",avatarData));BufferedReader reader=new BufferedReader(new InputStreamReader(s.getInputStream(),StandardCharsets.UTF_8));String line;while(!closed&&(line=reader.readLine())!=null){if(line.length()>16384)break;try{JSONObject event=new JSONObject(line);String type=event.optString("type");if("joined".equals(type)){joined=true;online=true;delay=1000;}if("error".equals(type)){listener.onEvent(event);break;}listener.onEvent(event);}catch(Exception ignored){}}}catch(Exception e){if(!closed)emitOffline();}finally{try{if(socket!=null)socket.close();}catch(Exception ignored){}socket=null;writer=null;}if(!closed){emitOffline();try{Thread.sleep(delay);}catch(InterruptedException e){Thread.currentThread().interrupt();break;}delay=Math.min(delay*2,30000);}}});}
    private String groupId(){String id=invite.optString("groupId");return id.isEmpty()?invite.optString("id"):id;}
    boolean isOnline(){return online && writer!=null && socket!=null && !socket.isClosed();}
    boolean sendText(String text){try{String value=text==null?"":text.trim();if(writer==null||socket==null||socket.isClosed()||value.isEmpty()||value.length()>4000)return false;JSONObject message=new JSONObject().put("type","message").put("groupId",groupId()).put("msgId",java.util.UUID.randomUUID().toString()).put("text",value);writerIo.execute(()->send(message));return true;}catch(Exception ignored){return false;}}
    void sendFile(ContentResolver resolver, Uri uri, String transferId, String fileId, String fileName, long size, String mime){
        if(resolver==null||uri==null||transferId==null||transferId.isEmpty()||fileId==null||fileId.isEmpty()||writer==null||socket==null||socket.isClosed())return;
        writerIo.execute(()->{
            try(InputStream input=resolver.openInputStream(uri)){
                if(input==null)return;
                JSONObject base=new JSONObject().put("groupId",groupId()).put("transferId",transferId).put("fileId",fileId).put("senderId",deviceId).put("senderName",name);
                JSONObject start=new JSONObject(base.toString()).put("type","file_start").put("name",fileName==null?"文件":fileName).put("size",Math.max(0,size)).put("mime",mime==null?"application/octet-stream":mime);
                if(!send(start))return;
                byte[] buffer=new byte[6144]; int read; int seq=0;
                while((read=input.read(buffer))>0){
                    JSONObject chunk=new JSONObject(base.toString()).put("type","file_chunk").put("seq",seq++).put("data",Base64.encodeToString(Arrays.copyOf(buffer,read),Base64.NO_WRAP));
                    if(!send(chunk))return;
                }
                send(new JSONObject(base.toString()).put("type","file_end"));
            }catch(Exception ignored){}
        });
    }
    void remove(String id){try{sendAsync(new JSONObject().put("type","remove").put("groupId",groupId()).put("targetId",id));}catch(Exception ignored){}}
    void dissolve(){try{sendAsync(new JSONObject().put("type","dissolve").put("groupId",groupId()));}catch(Exception ignored){}}
    void leave(){try{sendAsync(new JSONObject().put("type","leave").put("groupId",groupId()));}catch(Exception ignored){}}
    private void sendAsync(JSONObject msg){writerIo.execute(()->send(msg));}
    private boolean send(JSONObject msg){try{BufferedWriter w=writer;if(w==null)return false;synchronized(this){w.write(msg.toString());w.write("\n");w.flush();}return true;}catch(Exception ignored){return false;}}
    private void emitOffline(){if(online){online=false;try{listener.onEvent(new JSONObject().put("type","offline"));}catch(Exception ignored){}}}
    void close(){closed=true;try{if(socket!=null)socket.close();}catch(Exception ignored){}io.shutdownNow();writerIo.shutdownNow();}
}
