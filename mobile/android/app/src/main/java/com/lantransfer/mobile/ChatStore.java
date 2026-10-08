package com.lantransfer.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 安卓端聊天记录本地存储。
 *
 * 设计对齐桌面端 ChatStore 的语义：
 *   - 会话索引 + 每个对端一个消息列表
 *   - 消息状态：sent（已发送）/ delivered（已送达）/ read（已读）
 *   - 附件消息会带进度与完成态，这两个字段必须持久化，
 *     否则重启后「已完成/传一半的文件」会退回成「未开始」的外观。
 *
 * 存储用 SharedPreferences（消息量小，够用且无需权限）。
 */
class ChatStore {
    static final String STATUS_SENT = "sent";
    static final String STATUS_DELIVERED = "delivered";
    static final String STATUS_READ = "read";

    /** 每个对端最多保留的消息条数，超出裁掉最旧的。 */
    static final int MESSAGES_PER_CHAT = 500;

    private static final String PREFS = "nearby_transfer_chats";

    private final SharedPreferences prefs;

    ChatStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String keyFor(String peerId) {
        // SharedPreferences 的 key 可以做任意字符串，这里做一层清洗避免奇怪字符。
        return "msgs_" + (peerId == null ? "unknown" : peerId.replaceAll("[^A-Za-z0-9_-]", "_"));
    }

    /** 读取与某对端的全部消息（按时间升序）。 */
    synchronized List<JSONObject> list(String peerId) {
        List<JSONObject> out = new ArrayList<>();
        String raw = prefs.getString(keyFor(peerId), "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) out.add(item);
            }
        } catch (Exception ignored) { }
        return out;
    }

    private synchronized void persist(String peerId, List<JSONObject> messages) {
        try {
            JSONArray array = new JSONArray();
            int from = Math.max(0, messages.size() - MESSAGES_PER_CHAT);
            for (int i = from; i < messages.size(); i++) array.put(messages.get(i));
            prefs.edit().putString(keyFor(peerId), array.toString()).apply();
        } catch (Exception ignored) { }
    }

    /**
     * 追加一条消息。msgId 已存在则不重复插入（协议保证可能重发）。
     *
     * 注意：附件相关的 progress / done / transferId 字段必须原样写回，
     * 这是之前桌面端踩过的坑——白名单式拷贝会把它们丢掉。
     */
    synchronized void append(String peerId, JSONObject message) {
        String msgId = message.optString("msgId", "");
        List<JSONObject> messages = list(peerId);
        for (JSONObject existing : messages) {
            if (!msgId.isEmpty() && msgId.equals(existing.optString("msgId", ""))) return;
        }
        messages.add(message);
        persist(peerId, messages);
    }

    /** 更新某条消息的送达/已读状态。 */
    synchronized void updateStatus(String peerId, String msgId, String status) {
        if (TextUtils.isEmpty(msgId)) return;
        List<JSONObject> messages = list(peerId);
        boolean changed = false;
        for (JSONObject message : messages) {
            if (msgId.equals(message.optString("msgId", ""))) {
                try { message.put("status", status); } catch (Exception ignored) { }
                changed = true;
            }
        }
        if (changed) persist(peerId, messages);
    }

    /** 把某条带附件的消息更新为「已接收完成」（或失败）。 */
    synchronized void updateAttachmentDone(String peerId, String transferId, boolean done) {
        if (TextUtils.isEmpty(transferId)) return;
        List<JSONObject> messages = list(peerId);
        boolean changed = false;
        for (JSONObject message : messages) {
            if (transferId.equals(message.optString("transferId", ""))) {
                try { message.put("done", done); message.put("progress", done ? 100 : 0); } catch (Exception ignored) { }
                changed = true;
            }
        }
        if (changed) persist(peerId, messages);
    }

    synchronized void updateAttachmentProgress(String peerId, String transferId, int progress) {
        if (TextUtils.isEmpty(transferId)) return;
        List<JSONObject> messages = list(peerId); boolean changed = false;
        for (JSONObject message : messages) if (transferId.equals(message.optString("transferId", ""))) {
            try { message.put("progress", Math.max(0, Math.min(100, progress))); } catch (Exception ignored) { }
            changed = true;
        }
        if (changed) persist(peerId, messages);
    }

    synchronized void updateAttachmentLocation(String peerId, String transferId, String uri, String mime, boolean done) {
        if (TextUtils.isEmpty(transferId)) return;
        List<JSONObject> messages = list(peerId); boolean changed = false;
        for (JSONObject message : messages) if (transferId.equals(message.optString("transferId", ""))) {
            try { if (!TextUtils.isEmpty(uri)) message.put("localUri", uri); if (!TextUtils.isEmpty(mime)) message.put("mime", mime); message.put("done", done).put("progress", done ? 100 : message.optInt("progress", 0)); }
            catch (Exception ignored) { }
            changed = true;
        }
        if (changed) persist(peerId, messages);
    }

    synchronized void updateAttachmentFailure(String peerId, String transferId) {
        if (TextUtils.isEmpty(transferId)) return;
        List<JSONObject> messages = list(peerId); boolean changed = false;
        for (JSONObject message : messages) if (transferId.equals(message.optString("transferId", ""))) {
            try { message.put("failed", true); } catch (Exception ignored) { }
            changed = true;
        }
        if (changed) persist(peerId, messages);
    }

    /** 最近一条消息的时间戳，用于「已读位点」。 */
    synchronized long lastTs(String peerId) {
        List<JSONObject> messages = list(peerId);
        return messages.isEmpty() ? 0 : messages.get(messages.size() - 1).optLong("ts", 0);
    }

    /** 未读数：对端发来、且 ts 大于本地已读位点的条数。 */
    synchronized int unreadCount(String peerId, long readUpTo) {
        int count = 0;
        for (JSONObject message : list(peerId)) {
            if (!"in".equals(message.optString("dir", ""))) continue;
            if (message.optLong("ts", 0) > readUpTo) count++;
        }
        return count;
    }

    synchronized void clear(String peerId) {
        prefs.edit().remove(keyFor(peerId)).apply();
    }
}
