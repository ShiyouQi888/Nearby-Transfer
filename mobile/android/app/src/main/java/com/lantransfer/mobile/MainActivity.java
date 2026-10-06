package com.lantransfer.mobile;

import android.content.Intent;
import android.util.Base64;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.graphics.Typeface;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AppCompatActivity;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.ArrayList;
import java.util.List;

/** Native Android entry point. This screen does not use WebView or Capacitor. */
public class MainActivity extends AppCompatActivity implements NativeClient.Listener {
    private static final int PICK_FILES = 42;
    private EditText ipInput, codeInput;
    private TextView status;
    private Button connectButton, pickButton;
    private NativeClient client;
    private NativeDiscovery discovery;
    private final String deviceId = "mobile-" + Integer.toHexString((int) (System.nanoTime() & 0xfffffff));
    private ActivityResultLauncher<ScanOptions> qrLauncher;
    private final List<Uri> pendingUris = new ArrayList<>();
    private final List<CheckBox> pendingChecks = new ArrayList<>();
    private TextView pendingText;
    private LinearLayout pendingList;
    private LinearLayout connectionSection, sendSection, settingsSection;
    private FrameLayout pageHost;
    private Button navConnect, navSend, navSettings;
    private Button sendButton;
    private TextView receiveText;
    private LinearLayout receiveActions;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(15, 18, 16));
        createNotificationChannel();
        NativeDiscovery.AppContextHolder.context = getApplicationContext();
        discovery = new NativeDiscovery(deviceId);
        discovery.start();
        qrLauncher = registerForActivityResult(new ScanContract(), result -> { if (result.getContents() != null && !connectFromQr(result.getContents())) toast("二维码内容无法识别"); });
        buildUi();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(15, 18, 16));
        LinearLayout header = new LinearLayout(this); header.setOrientation(LinearLayout.VERTICAL); header.setPadding(dp(24), dp(22), dp(24), dp(10));
        header.addView(text("邻传", 30, Color.WHITE), new LinearLayout.LayoutParams(-1, dp(44)));
        header.addView(text("局域网高速互传", 14, Color.rgb(163, 167, 164)), new LinearLayout.LayoutParams(-1, dp(28)));
        status = text("未连接", 14, Color.rgb(0, 232, 135)); status.setGravity(Gravity.CENTER_VERTICAL); header.addView(status, new LinearLayout.LayoutParams(-1, dp(36)));
        root.addView(header, new LinearLayout.LayoutParams(-1, -2));

        connectionSection = new LinearLayout(this); connectionSection.setOrientation(LinearLayout.VERTICAL);
        TextView section = text("连接电脑", 20, Color.WHITE); section.setPadding(0, dp(12), 0, dp(8)); connectionSection.addView(section, params(-1, 60));
        ipInput = input("电脑 IP，例如 192.168.1.23"); connectionSection.addView(ipInput, params(-1, 52));
        codeInput = input("6 位匹配码"); codeInput.setInputType(InputType.TYPE_CLASS_NUMBER); connectionSection.addView(codeInput, params(-1, 52));
        connectButton = button("使用匹配码连接"); connectButton.setOnClickListener(v -> connect()); connectionSection.addView(connectButton, params(-1, 52));
        Button scanButton = button("扫描电脑二维码"); scanButton.setTextColor(Color.WHITE); scanButton.setBackground(box(Color.rgb(31,36,33), Color.rgb(7,193,96), dp(12))); scanButton.setOnClickListener(v -> scanQr()); connectionSection.addView(scanButton, params(-1, 52));

        sendSection = new LinearLayout(this); sendSection.setOrientation(LinearLayout.VERTICAL);
        TextView sendTitle = text("发送文件", 20, Color.WHITE); sendTitle.setPadding(0, dp(22), 0, dp(8)); sendSection.addView(sendTitle, params(-1, 60));
        pickButton = button("选择文件（加入待发送）"); pickButton.setOnClickListener(v -> pickFiles()); sendSection.addView(pickButton, params(-1, 52));
        pendingText = text("待发送区：暂无文件", 14, Color.rgb(163, 167, 164)); pendingText.setPadding(0, dp(10), 0, dp(4)); sendSection.addView(pendingText, params(-1, 38));
        pendingList = new LinearLayout(this); pendingList.setOrientation(LinearLayout.VERTICAL); pendingList.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(12))); sendSection.addView(pendingList, params(-1, -2));
        sendButton = button("发送已勾选文件"); sendButton.setOnClickListener(v -> sendPendingFiles()); sendSection.addView(sendButton, params(-1, 52));
        receiveText = text("接收区：暂无文件", 14, Color.rgb(163, 167, 164)); receiveText.setPadding(0, dp(10), 0, dp(20)); sendSection.addView(receiveText, params(-1, 48));
        receiveActions = new LinearLayout(this); receiveActions.setOrientation(LinearLayout.HORIZONTAL); receiveActions.setGravity(Gravity.CENTER_VERTICAL); receiveActions.setPadding(0, 0, 0, 0); receiveActions.setBackgroundColor(Color.TRANSPARENT); receiveActions.setVisibility(View.GONE);
        Button rejectReceive = button("拒绝接收"); rejectReceive.setTextColor(Color.WHITE); rejectReceive.setBackground(box(Color.rgb(31,36,33), Color.rgb(180,70,80), dp(12))); rejectReceive.setOnClickListener(v -> { if (client != null) client.rejectIncomingOffer(); receiveActions.setVisibility(View.GONE); receiveText.setText("接收区：已拒绝"); });
        Button acceptReceive = button("确认接收"); acceptReceive.setOnClickListener(v -> { if (client != null) client.acceptIncomingOffer(); receiveActions.setVisibility(View.GONE); receiveText.setText("接收区：正在接收"); });
        receiveActions.addView(rejectReceive, new LinearLayout.LayoutParams(0, dp(52), 1)); receiveActions.addView(acceptReceive, new LinearLayout.LayoutParams(0, dp(52), 1)); sendSection.addView(receiveActions, params(-1, 64));

        settingsSection = new LinearLayout(this); settingsSection.setOrientation(LinearLayout.VERTICAL);
        TextView settingsTitle = text("设置", 20, Color.WHITE); settingsTitle.setPadding(0, dp(22), 0, dp(8)); settingsSection.addView(settingsTitle, params(-1, 60));
        TextView settingsInfo = text("应用信息\n邻传 Nearby Transfer\n原生 Android 应用\n\n网络要求\n手机和电脑连接同一 Wi‑Fi，局域网内直连传输。\n\n文件保存位置\n接收文件默认保存到：下载 / 邻传", 14, Color.rgb(163, 167, 164)); settingsInfo.setPadding(dp(16), dp(14), dp(16), dp(14)); settingsInfo.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(12))); settingsSection.addView(settingsInfo, params(-1, 178));
        TextView contactTitle = text("关于与联系", 18, Color.WHITE); contactTitle.setPadding(0, dp(22), 0, dp(8)); settingsSection.addView(contactTitle, params(-1, 60));
        TextView contactInfo = text("作者：齐世有\n邮箱：blacklaw@foxmail.com\n版权：© 2026 邻传 Nearby Transfer\n本软件仅用于同一局域网内的设备互传。", 14, Color.rgb(163, 167, 164)); contactInfo.setPadding(dp(16), dp(14), dp(16), dp(14)); contactInfo.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(12))); settingsSection.addView(contactInfo, params(-1, 128));
        TextView quickTitle = text("快捷入口", 17, Color.WHITE); quickTitle.setPadding(0, dp(22), 0, dp(2)); settingsSection.addView(quickTitle, params(-1, 42));
        TextView quickHint = text("点击图标访问相关页面", 12, Color.rgb(127, 132, 128)); settingsSection.addView(quickHint, params(-1, 28));
        LinearLayout linkRow = new LinearLayout(this); linkRow.setOrientation(LinearLayout.HORIZONTAL); linkRow.setGravity(Gravity.CENTER); linkRow.setPadding(0, dp(4), 0, dp(4));
        LinearLayout.LayoutParams linkParams = new LinearLayout.LayoutParams(0, dp(104), 1); linkParams.setMargins(0, 0, dp(5), 0);
        linkRow.addView(linkTile("↗", "官网", "官方网站", v -> openExternal("https://linchuan.aeback.com")), linkParams);
        linkParams = new LinearLayout.LayoutParams(0, dp(104), 1); linkParams.setMargins(dp(3), 0, dp(3), 0);
        linkRow.addView(linkTile("GH", "GitHub", "项目源码", v -> openExternal("https://github.com/ShiyouQi888/Nearby-Transfer")), linkParams);
        linkParams = new LinearLayout.LayoutParams(0, dp(104), 1); linkParams.setMargins(dp(5), 0, 0, 0);
        linkRow.addView(linkTile("@", "联系作者", "发送邮件", v -> openExternal("mailto:blacklaw@foxmail.com")), linkParams);
        settingsSection.addView(linkRow, params(-1, 116));

        pageHost = new FrameLayout(this); pageHost.setBackgroundColor(Color.rgb(15, 18, 16));
        pageHost.addView(page(connectionSection)); pageHost.addView(page(sendSection)); pageHost.addView(page(settingsSection));
        root.addView(pageHost, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout nav = new LinearLayout(this); nav.setOrientation(LinearLayout.HORIZONTAL); nav.setGravity(Gravity.CENTER); nav.setPadding(dp(12), dp(6), dp(12), dp(8)); nav.setBackgroundColor(Color.rgb(20,24,22));
        navConnect = navButton("连接"); navSend = navButton("发送"); navSettings = navButton("设置");
        navConnect.setOnClickListener(v -> showPage(0)); navSend.setOnClickListener(v -> showPage(1)); navSettings.setOnClickListener(v -> showPage(2));
        nav.addView(navConnect, new LinearLayout.LayoutParams(0, dp(52), 1)); nav.addView(navSend, new LinearLayout.LayoutParams(0, dp(52), 1)); nav.addView(navSettings, new LinearLayout.LayoutParams(0, dp(52), 1)); root.addView(nav, new LinearLayout.LayoutParams(-1, dp(68)));
        setContentView(root);
        showPage(0);
        updatePendingText();
    }

    private ScrollView page(View content) {
        ScrollView page = new ScrollView(this); page.setFillViewport(true); page.setBackgroundColor(Color.rgb(15, 18, 16));
        LinearLayout wrapper = new LinearLayout(this); wrapper.setOrientation(LinearLayout.VERTICAL); wrapper.setPadding(dp(24), dp(4), dp(24), dp(22)); wrapper.addView(content, new LinearLayout.LayoutParams(-1, -2));
        page.addView(wrapper, new ScrollView.LayoutParams(-1, -2)); return page;
    }

    private void showPage(int index) {
        if (pageHost == null) return;
        for (int i = 0; i < pageHost.getChildCount(); i++) pageHost.getChildAt(i).setVisibility(i == index ? View.VISIBLE : View.GONE);
        Button[] nav = { navConnect, navSend, navSettings };
        for (int i = 0; i < nav.length; i++) if (nav[i] != null) nav[i].setTextColor(i == index ? Color.rgb(0, 232, 135) : Color.rgb(163, 167, 164));
    }

    private void connect() {
        String ip = ipInput.getText().toString().trim(), code = codeInput.getText().toString().trim();
        if (ip.isEmpty() || code.length() != 6) { toast("请输入电脑 IP 和 6 位匹配码"); return; }
        connectButton.setEnabled(false); status.setText("正在连接…");
        client = new NativeClient(deviceId, "我的手机", this); client.connect(ip, NativeClient.PORT, code);
    }

    private void scanQr() {
        ScanOptions options = new ScanOptions(); options.setDesiredBarcodeFormats(ScanOptions.QR_CODE); options.setPrompt("将电脑端二维码放入正方形取景框"); options.setBeepEnabled(false); options.setOrientationLocked(true);
        qrLauncher.launch(options);
    }

    private boolean connectFromQr(String raw) {
        try {
            String payload = raw == null ? "" : raw.trim();
            if (payload.startsWith("LTP1:")) {
                String encoded = payload.substring(5).replace('-', '+').replace('_', '/');
                while ((encoded.length() & 3) != 0) encoded += "=";
                payload = new String(Base64.decode(encoded, Base64.DEFAULT), java.nio.charset.StandardCharsets.UTF_8);
            }
            org.json.JSONObject q = new org.json.JSONObject(payload); String ip = q.optString("ip"); int port = q.optInt("port", NativeClient.PORT); String token = q.optString("token");
            if (ip.isEmpty() || token.isEmpty()) return false;
            connectButton.setEnabled(false); status.setText("正在扫码配对…");
            client = new NativeClient(deviceId, "我的手机", this); client.connectWithQr(ip, port, token); return true;
        } catch (Exception ignored) { return false; }
    }

    private void pickFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_FILES); } catch (Exception e) { toast("无法打开文件选择器，请检查系统文件应用"); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data); if (request != PICK_FILES || result != RESULT_OK || data == null) return;
        if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) addPickedUri(data.getClipData().getItemAt(i).getUri()); else if (data.getData() != null) addPickedUri(data.getData());
        updatePendingText();
    }

    private void addPickedUri(Uri uri) {
        if (uri == null) return;
        for (Uri existing : pendingUris) if (existing.toString().equals(uri.toString())) return;
        try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {}
        pendingUris.add(uri);
    }

    private void sendPendingFiles() {
        List<Uri> selected = new ArrayList<>();
        for (CheckBox check : pendingChecks) if (check.isChecked() && check.getTag() instanceof Uri) selected.add((Uri) check.getTag());
        if (selected.isEmpty()) { toast("请先勾选要发送的文件"); return; }
        if (client == null || !client.isConnected()) { toast("请先连接电脑，再发送待选文件"); return; }
        client.sendFiles(getContentResolver(), selected); pendingUris.removeAll(selected); updatePendingText(); toast("已发送 " + selected.size() + " 个文件，等待电脑确认");
    }

    private void updatePendingText() {
        int selected = 0;
        for (CheckBox check : pendingChecks) if (check.isChecked()) selected++;
        if (pendingText != null) pendingText.setText(pendingUris.isEmpty() ? "待发送区：暂无文件" : "待发送区：" + pendingUris.size() + " 个文件，已勾选 " + selected + " 个");
        if (pendingList == null) return;
        boolean hadRenderedItems = !pendingChecks.isEmpty();
        java.util.HashSet<String> selectedUris = new java.util.HashSet<>();
        for (CheckBox check : pendingChecks) if (check.isChecked() && check.getTag() instanceof Uri) selectedUris.add(check.getTag().toString());
        pendingList.removeAllViews(); pendingChecks.clear();
        for (Uri uri : pendingUris) {
            CheckBox check = new CheckBox(this);
            check.setText(displayName(uri)); check.setTextColor(Color.WHITE); check.setTextSize(14); check.setChecked(true); check.setTag(uri);
            check.setChecked(!hadRenderedItems || selectedUris.contains(uri.toString()));
            check.setPadding(dp(12), 0, dp(12), 0); check.setButtonTintList(android.content.res.ColorStateList.valueOf(Color.rgb(0, 210, 131)));
            check.setOnCheckedChangeListener((buttonView, isChecked) -> { updatePendingText(); updateSendButtonState(); });
            pendingChecks.add(check); pendingList.addView(check, new LinearLayout.LayoutParams(-1, dp(48)));
        }
        updateSendButtonState();
    }

    private String displayName(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {}
        return uri == null ? "未知文件" : uri.toString();
    }

    private void updateSendButtonState() {
        boolean selected = false;
        for (CheckBox check : pendingChecks) if (check.isChecked()) { selected = true; break; }
        if (sendButton != null) sendButton.setEnabled(selected && client != null && client.isConnected());
    }

    private Button navButton(String label) {
        Button b = button(label); b.setTextColor(Color.rgb(163, 167, 164)); b.setBackgroundColor(Color.TRANSPARENT); return b;
    }

    private LinearLayout linkTile(String glyph, String label, String subtitle, View.OnClickListener listener) {
        LinearLayout tile = new LinearLayout(this); tile.setOrientation(LinearLayout.VERTICAL); tile.setGravity(Gravity.CENTER); tile.setPadding(dp(4), dp(8), dp(4), dp(7));
        tile.setBackground(box(Color.rgb(24, 31, 27), Color.rgb(47, 65, 55), dp(16))); tile.setClickable(true); tile.setFocusable(true); tile.setContentDescription(label); tile.setOnClickListener(listener); tile.setElevation(dp(2));
        LinearLayout iconWrap = new LinearLayout(this); iconWrap.setGravity(Gravity.CENTER); iconWrap.setBackground(box(Color.rgb(7, 73, 45), Color.rgb(0, 210, 131), dp(20)));
        TextView icon = text(glyph, glyph.equals("GH") ? 16 : 23, Color.rgb(0, 240, 145)); icon.setGravity(Gravity.CENTER); icon.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); iconWrap.addView(icon, new LinearLayout.LayoutParams(-1, -1));
        tile.addView(iconWrap, new LinearLayout.LayoutParams(dp(40), dp(40)));
        TextView title = text(label, 12, Color.WHITE); title.setGravity(Gravity.CENTER); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); tile.addView(title, new LinearLayout.LayoutParams(-1, dp(22)));
        TextView detail = text(subtitle, 10, Color.rgb(127, 160, 143)); detail.setGravity(Gravity.CENTER); tile.addView(detail, new LinearLayout.LayoutParams(-1, dp(18)));
        return tile;
    }

    private void openExternal(String uri) {
        try { startActivity(new Intent(uri.startsWith("mailto:") ? Intent.ACTION_SENDTO : Intent.ACTION_VIEW, Uri.parse(uri))); }
        catch (Exception ignored) { toast("无法打开链接，请检查系统应用"); }
    }

    @Override public void onConnected(String name) { runOnUiThread(() -> { status.setText("已连接 · " + name); connectButton.setEnabled(true); connectButton.setText("已连接"); pickButton.setText("选择文件（加入待发送）"); updateSendButtonState(); }); }
    @Override public void onError(String message) { runOnUiThread(() -> { status.setText("连接失败"); connectButton.setEnabled(true); updateSendButtonState(); toast(message); }); }
    @Override public void onClosed() { runOnUiThread(() -> { status.setText("连接已断开"); connectButton.setEnabled(true); pickButton.setText("选择文件（加入待发送）"); updateSendButtonState(); }); }
    @Override public void onIncomingOffer(String label) { runOnUiThread(() -> { status.setText("等待接收确认"); receiveText.setText("待确认：" + label + "\n保存位置：下载/邻传"); receiveActions.setVisibility(View.VISIBLE); toast("收到文件，请选择接收或拒绝"); showIncomingNotification(label); }); }

    private void createNotificationChannel() { if (Build.VERSION.SDK_INT >= 26) { NotificationChannel c = new NotificationChannel("transfer", "文件传输", NotificationManager.IMPORTANCE_DEFAULT); getSystemService(NotificationManager.class).createNotificationChannel(c); } }
    private void showIncomingNotification(String label) { if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 77); return; } NotificationManager n = (NotificationManager) getSystemService(NOTIFICATION_SERVICE); n.notify(77, new android.app.Notification.Builder(this, "transfer").setSmallIcon(com.lantransfer.mobile.R.mipmap.ic_launcher).setContentTitle("邻传收到文件").setContentText(label + "，等待你确认接收").setAutoCancel(true).build()); }
    @Override public void onProgress(int percent) { runOnUiThread(() -> status.setText("已连接 · 已发送 " + percent + "%")); }
    @Override protected void onDestroy() { if (client != null) client.close(); if (discovery != null) discovery.stop(); super.onDestroy(); }

    private TextView text(String value, int size, int color) { TextView v = new TextView(this); v.setText(value); v.setTextSize(size); v.setTextColor(color); v.setBackgroundColor(Color.TRANSPARENT); return v; }
    private EditText input(String hint) { EditText v = new EditText(this); v.setHint(hint); v.setHintTextColor(Color.rgb(127,132,128)); v.setTextColor(Color.WHITE); v.setTextSize(15); v.setSingleLine(true); v.setPadding(dp(16), 0, dp(16), 0); v.setBackground(box(Color.rgb(31,36,33), Color.rgb(42,47,45), dp(12))); return v; }
    private Button button(String label) { Button b = new Button(this); b.setText(label); b.setTextSize(15); b.setTextColor(Color.rgb(7,26,18)); b.setAllCaps(false); b.setPadding(dp(12), 0, dp(12), 0); b.setBackground(box(Color.rgb(7,193,96), Color.rgb(7,193,96), dp(12))); return b; }
    private GradientDrawable box(int fill, int stroke, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(fill); d.setCornerRadius(radius); d.setStroke(dp(1), stroke); return d; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout.LayoutParams params(int width, int height) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(width, dp(height)); p.setMargins(0, dp(6), 0, dp(6)); return p; }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
