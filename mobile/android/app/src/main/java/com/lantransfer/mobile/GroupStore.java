package com.lantransfer.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Small persistent store for LAN group metadata and text history. */
final class GroupStore {
    private final SharedPreferences prefs;
    GroupStore(Context context) { prefs = context.getApplicationContext().getSharedPreferences("nearby_transfer_groups", Context.MODE_PRIVATE); }

    synchronized List<JSONObject> list() {
        List<JSONObject> out = new ArrayList<>();
        try { JSONArray a = new JSONArray(prefs.getString("groups", "[]")); for (int i=0;i<a.length();i++) { JSONObject g=a.optJSONObject(i); if(g!=null && !g.optBoolean("dissolved")) out.add(g); } } catch(Exception ignored) { }
        return out;
    }
    synchronized JSONObject get(String id) { for (JSONObject g : list()) if (id.equals(g.optString("id"))) return g; return null; }
    synchronized void save(JSONObject group) {
        try { List<JSONObject> all = listIncludingDissolved(); JSONArray a = new JSONArray(); boolean replaced=false; for(JSONObject g:all) { if(group.optString("id").equals(g.optString("id"))) { a.put(group); replaced=true; } else a.put(g); } if(!replaced)a.put(group); prefs.edit().putString("groups", a.toString()).apply(); }
        catch(Exception ignored) { }
    }
    private List<JSONObject> listIncludingDissolved() {
        List<JSONObject> out=new ArrayList<>(); try { JSONArray a=new JSONArray(prefs.getString("groups","[]")); for(int i=0;i<a.length();i++){JSONObject g=a.optJSONObject(i);if(g!=null)out.add(g);} }catch(Exception ignored){} return out;
    }
    synchronized JSONObject create(String id,String name,String ownerId,String ownerName,String host,int port,String token,String inviteCode,String avatarData) {
        try { long now=System.currentTimeMillis(); JSONObject owner=new JSONObject().put("deviceId",ownerId).put("name",ownerName).put("type","mobile").put("avatarData",avatarData==null?"":avatarData).put("joinedAt",now); JSONObject g=new JSONObject().put("id",id).put("name",name).put("ownerId",ownerId).put("ownerName",ownerName).put("host",host).put("port",port).put("token",token).put("inviteCode",inviteCode).put("inviteExpiresAt",now+10*60*1000L).put("members",new JSONArray().put(owner)).put("bannedIds",new JSONArray()).put("messages",new JSONArray()).put("unread",0).put("createdAt",now).put("updatedAt",now).put("dissolved",false); save(g); return g; } catch(Exception e){return null;}
    }
    synchronized JSONObject join(JSONObject invite,String selfId,String selfName) {
        try { JSONObject old=get(invite.optString("groupId")); if(old!=null)return old; long now=System.currentTimeMillis(); JSONObject g=new JSONObject().put("id",invite.getString("groupId")).put("name",invite.optString("name","群聊")).put("ownerId",invite.optString("ownerId")).put("ownerName",invite.optString("ownerName")).put("host",invite.getString("host")).put("port",invite.optInt("port",GroupHostService.PORT)).put("token",invite.getString("token")).put("members",new JSONArray().put(new JSONObject().put("deviceId",selfId).put("name",selfName).put("type","mobile").put("avatarData",invite.optString("memberAvatarData","")).put("joinedAt",now))).put("messages",new JSONArray()).put("unread",0).put("createdAt",now).put("updatedAt",now).put("dissolved",false);save(g);return g;}catch(Exception e){return null;}
    }
    synchronized void mergeRemote(String id,JSONObject remote) {
        try { JSONObject g=get(id); if(g==null)return; g.put("name",remote.optString("name",g.optString("name"))).put("ownerId",remote.optString("ownerId",g.optString("ownerId"))).put("ownerName",remote.optString("ownerName",g.optString("ownerName"))).put("updatedAt",System.currentTimeMillis()); if(remote.has("members"))g.put("members",remote.optJSONArray("members")); JSONArray incoming=remote.optJSONArray("messages"); save(g); if(incoming!=null){for(int i=0;i<incoming.length();i++){JSONObject m=incoming.optJSONObject(i);if(m!=null)append(id,m);} } }catch(Exception ignored){}
    }
    synchronized JSONObject append(String id, JSONObject message) { return append(id,message,false); }
    synchronized JSONObject append(String id, JSONObject message, boolean unread) {
        try { JSONObject g=get(id); if(g==null)return null; JSONArray a=g.optJSONArray("messages"); if(a==null)a=new JSONArray(); String msgId=message.optString("msgId"); for(int i=0;i<a.length();i++)if(msgId.equals(a.optJSONObject(i).optString("msgId")))return null; a.put(message); while(a.length()>1000)a.remove(0); int count=g.optInt("unread",0); g.put("messages",a).put("lastMessage",message).put("unread",unread?Math.min(999,count+1):count).put("updatedAt",message.optLong("ts",System.currentTimeMillis())); save(g); return message; } catch(Exception e){return null;}
    }
    synchronized void markRead(String id) { try { JSONObject g=get(id); if(g!=null){g.put("unread",0);save(g);} } catch(Exception ignored){} }
    synchronized void setMembers(String id, JSONArray members) { try { JSONObject g=get(id); if(g!=null){g.put("members",members==null?new JSONArray():members);g.put("updatedAt",System.currentTimeMillis());save(g);} }catch(Exception ignored){} }
    synchronized void updateInvite(String id,String code,long expiresAt){try{JSONObject g=get(id);if(g!=null){g.put("inviteCode",code).put("inviteExpiresAt",expiresAt).put("updatedAt",System.currentTimeMillis());save(g);}}catch(Exception ignored){}}
    synchronized void remove(String id) { dissolve(id); }
    synchronized void ban(String id,String deviceId) { try{JSONObject g=get(id);if(g==null)return;JSONArray banned=g.optJSONArray("bannedIds");if(banned==null)banned=new JSONArray();boolean exists=false;for(int i=0;i<banned.length();i++)if(deviceId.equals(banned.optString(i)))exists=true;if(!exists)banned.put(deviceId);JSONArray old=g.optJSONArray("members"),next=new JSONArray();if(old!=null)for(int i=0;i<old.length();i++){JSONObject m=old.optJSONObject(i);if(m!=null&&!deviceId.equals(m.optString("deviceId")))next.put(m);}g.put("bannedIds",banned).put("members",next).put("updatedAt",System.currentTimeMillis());save(g);}catch(Exception ignored){} }
    synchronized void dissolve(String id) { try { JSONObject g=get(id); if(g!=null){g.put("dissolved",true).put("updatedAt",System.currentTimeMillis());save(g);} }catch(Exception ignored){} }
}
