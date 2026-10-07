package com.lantransfer.mobile;

import android.content.Intent;
import android.util.Base64;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
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
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.UUID;

/** Native Android entry point. This screen does not use WebView or Capacitor. */
public class MainActivity extends AppCompatActivity implements NativeClient.Listener {
    private static final int PICK_FILES = 42;
    private EditText ipInput, codeInput;
    private EditText deviceNameInput;
    private TextView status;
    private Button connectButton, pickButton;
    private Button scanDevicesButton;
    private NativeClient client;
    private NativeDiscovery discovery;
    /** Stable per-installation identity used by LAN discovery and trusted-device records. */
    private String deviceId;
    private ActivityResultLauncher<ScanOptions> qrLauncher;
    private final List<Uri> pendingUris = new ArrayList<>();
    private final List<CheckBox> pendingChecks = new ArrayList<>();
    private TextView pendingText;
    private final java.util.concurrent.ExecutorService thumbnailExecutor = java.util.concurrent.Executors.newFixedThreadPool(2);
    private LinearLayout pendingList;
    private LinearLayout transferHistoryList;
    private LinearLayout discoveredDevices;
    private LinearLayout pairedDevicesList;
    private LinearLayout connectionSection, sendSection, settingsSection;
    private FrameLayout pageHost;
    private Button navConnect, navSend, navSettings;
    private Button sendButton;
    private Button updateButton;
    private TextView updateStatus;
    private Button languageButton;
    private boolean english;
    private boolean sendInProgress;
    private TextView receiveText;
    private LinearLayout receiveActions;
    private FrameLayout incomingOverlay;
    private TextView incomingOverlayText;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        SharedPreferences identity = getSharedPreferences("nearby_transfer_identity", MODE_PRIVATE);
        deviceId = identity.getString("device_id", null);
        if (deviceId == null || deviceId.trim().isEmpty()) {
            deviceId = "mobile-" + UUID.randomUUID().toString().replace("-", "");
            identity.edit().putString("device_id", deviceId).apply();
        }
        english = getPreferences(MODE_PRIVATE).getBoolean("english", false);
        if (!identity.contains("device_name")) identity.edit().putString("device_name", english ? "My phone" : "我的手机").apply();
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
        LinearLayout header = new LinearLayout(this); header.setOrientation(LinearLayout.VERTICAL); header.setPadding(dp(24), dp(18), dp(24), dp(10));
        LinearLayout headerTop = new LinearLayout(this); headerTop.setOrientation(LinearLayout.HORIZONTAL); headerTop.setGravity(Gravity.CENTER_VERTICAL);
        headerTop.addView(text("邻传", 30, Color.WHITE), new LinearLayout.LayoutParams(0, dp(48), 1));
        languageButton = compactLanguageButton(); headerTop.addView(languageButton, new LinearLayout.LayoutParams(dp(52), dp(36)));
        header.addView(headerTop, new LinearLayout.LayoutParams(-1, dp(48)));
        header.addView(text("局域网高速互传", 14, Color.rgb(163, 167, 164)), new LinearLayout.LayoutParams(-1, dp(28)));
        status = text("未连接", 14, Color.rgb(0, 232, 135)); status.setGravity(Gravity.CENTER_VERTICAL); header.addView(status, new LinearLayout.LayoutParams(-1, dp(36)));
        root.addView(header, new LinearLayout.LayoutParams(-1, -2));

        connectionSection = new LinearLayout(this); connectionSection.setOrientation(LinearLayout.VERTICAL);
        TextView section = text("连接电脑", 20, Color.WHITE); section.setPadding(0, dp(12), 0, dp(8)); connectionSection.addView(section, params(-1, 60));
        ipInput = input("电脑 IP，例如 192.168.1.23"); connectionSection.addView(ipInput, params(-1, 52));
        codeInput = input("6 位匹配码"); codeInput.setInputType(InputType.TYPE_CLASS_NUMBER); connectionSection.addView(codeInput, params(-1, 52));
        connectButton = button("使用匹配码连接"); connectButton.setOnClickListener(v -> connect()); connectionSection.addView(connectButton, params(-1, 52));
        scanDevicesButton = button("扫描局域网设备"); scanDevicesButton.setTextColor(Color.WHITE); scanDevicesButton.setBackground(box(Color.rgb(31,36,33), Color.rgb(7,193,96), dp(12))); scanDevicesButton.setOnClickListener(v -> scanDevices()); connectionSection.addView(scanDevicesButton, params(-1, 48));
        discoveredDevices = new LinearLayout(this); discoveredDevices.setOrientation(LinearLayout.VERTICAL); connectionSection.addView(discoveredDevices, params(-1, -2));
        TextView pairedTitle = text("历史设备", 17, Color.WHITE); pairedTitle.setPadding(0, dp(14), 0, dp(2)); connectionSection.addView(pairedTitle, params(-1, 42));
        pairedDevicesList = new LinearLayout(this); pairedDevicesList.setOrientation(LinearLayout.VERTICAL); connectionSection.addView(pairedDevicesList, params(-1, -2));
        Button scanButton = button("扫描电脑二维码"); scanButton.setTextColor(Color.WHITE); scanButton.setBackground(box(Color.rgb(31,36,33), Color.rgb(7,193,96), dp(12))); scanButton.setOnClickListener(v -> scanQr()); connectionSection.addView(scanButton, params(-1, 52));

        sendSection = new LinearLayout(this); sendSection.setOrientation(LinearLayout.VERTICAL);
        TextView sendTitle = text("发送文件", 20, Color.WHITE); sendTitle.setPadding(0, dp(22), 0, dp(8)); sendSection.addView(sendTitle, params(-1, 60));
        pickButton = button("选择文件"); pickButton.setOnClickListener(v -> pickFiles()); sendSection.addView(pickButton, params(-1, 52));
        pendingText = text("待发送区：暂无文件", 14, Color.rgb(163, 167, 164)); pendingText.setPadding(0, dp(10), 0, dp(4)); sendSection.addView(pendingText, params(-1, 38));
        pendingList = new LinearLayout(this); pendingList.setOrientation(LinearLayout.VERTICAL); pendingList.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(12))); sendSection.addView(pendingList, params(-1, -2));
        sendButton = button("发送文件"); sendButton.setOnClickListener(v -> sendPendingFiles()); sendSection.addView(sendButton, params(-1, 52));
        receiveText = text("接收区：暂无文件", 14, Color.rgb(163, 167, 164)); receiveText.setPadding(0, dp(10), 0, dp(20)); sendSection.addView(receiveText, params(-1, -2));
        LinearLayout historyHeader = new LinearLayout(this); historyHeader.setOrientation(LinearLayout.HORIZONTAL); historyHeader.setGravity(Gravity.CENTER_VERTICAL);
        TextView historyTitle = text("最近传输", 17, Color.WHITE); historyHeader.addView(historyTitle, new LinearLayout.LayoutParams(0, dp(42), 1));
        Button clearHistory = new Button(this); clearHistory.setText(tr("清空记录")); clearHistory.setTextSize(12); clearHistory.setAllCaps(false); clearHistory.setTextColor(Color.rgb(255, 118, 126)); clearHistory.setBackgroundColor(Color.TRANSPARENT); clearHistory.setOnClickListener(v -> { getPreferences(MODE_PRIVATE).edit().remove("transfer_history").apply(); renderTransferHistory(); }); historyHeader.addView(clearHistory, new LinearLayout.LayoutParams(-2, dp(42))); sendSection.addView(historyHeader, params(-1, 42));
        transferHistoryList = new LinearLayout(this); transferHistoryList.setOrientation(LinearLayout.VERTICAL); sendSection.addView(transferHistoryList, params(-1, -2));
        receiveActions = new LinearLayout(this); receiveActions.setOrientation(LinearLayout.HORIZONTAL); receiveActions.setGravity(Gravity.CENTER_VERTICAL); receiveActions.setPadding(0, 0, 0, 0); receiveActions.setBackgroundColor(Color.TRANSPARENT); receiveActions.setVisibility(View.GONE);
        Button rejectReceive = button("拒绝接收"); rejectReceive.setTextColor(Color.WHITE); rejectReceive.setBackground(box(Color.rgb(31,36,33), Color.rgb(180,70,80), dp(12))); rejectReceive.setOnClickListener(v -> { if (client != null) client.rejectIncomingOffer(); hideIncomingOverlay(); receiveActions.setVisibility(View.GONE); receiveText.setText(english ? "Receive: rejected" : "接收区：已拒绝"); });
        Button acceptReceive = button("确认接收"); acceptReceive.setOnClickListener(v -> { if (client != null) client.acceptIncomingOffer(); hideIncomingOverlay(); receiveActions.setVisibility(View.GONE); receiveText.setText(english ? "Receive: receiving" : "接收区：正在接收"); });
        // 接收确认统一使用全局浮层，发送页不再重复显示一套确认按钮。

        settingsSection = new LinearLayout(this); settingsSection.setOrientation(LinearLayout.VERTICAL);
        TextView settingsTitle = text("设置", 22, Color.WHITE); settingsTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); settingsTitle.setPadding(0, dp(8), 0, 0); settingsSection.addView(settingsTitle, params(-1, 44));
        TextView settingsSubtitle = text(english ? "Personalize your device and manage the app" : "管理设备信息、应用版本与相关链接", 12, Color.rgb(127, 145, 134)); settingsSection.addView(settingsSubtitle, params(-1, 28));

        TextView deviceNameTitle = text("设备名称", 14, Color.rgb(163, 185, 171)); deviceNameTitle.setPadding(dp(2), 0, 0, 0); settingsSection.addView(deviceNameTitle, params(-1, 28));
        LinearLayout deviceCard = new LinearLayout(this); deviceCard.setOrientation(LinearLayout.VERTICAL); deviceCard.setPadding(dp(12), dp(10), dp(12), dp(10)); deviceCard.setBackground(box(Color.rgb(24, 30, 27), Color.rgb(42, 52, 46), dp(14)));
        TextView deviceHint = text(english ? "Shown to nearby devices" : "附近设备将看到此名称", 11, Color.rgb(127, 145, 134)); deviceCard.addView(deviceHint, params(-1, 20));
        LinearLayout nameRow = new LinearLayout(this); nameRow.setOrientation(LinearLayout.VERTICAL);
        deviceNameInput = input(deviceName()); deviceNameInput.setText(deviceName()); LinearLayout.LayoutParams nameInputParams = new LinearLayout.LayoutParams(-1, dp(46)); nameInputParams.topMargin = dp(6); nameRow.addView(deviceNameInput, nameInputParams);
        Button saveDeviceName = button("保存设备名称"); saveDeviceName.setTextSize(14); saveDeviceName.setOnClickListener(v -> { String name = deviceNameInput.getText().toString().trim(); if (name.isEmpty()) { toast(english ? "Device name cannot be empty" : "设备名称不能为空"); return; } getSharedPreferences("nearby_transfer_identity", MODE_PRIVATE).edit().putString("device_name", name).apply(); discovery.announceNow(); toast(english ? "Device name updated" : "设备名称已更新"); });
        LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(-1, dp(44)); saveParams.topMargin = dp(8); nameRow.addView(saveDeviceName, saveParams); deviceCard.addView(nameRow, params(-1, -2)); settingsSection.addView(deviceCard, params(-1, -2));

        TextView networkTitle = text(english ? "Network & security" : "网络与安全", 14, Color.rgb(163, 185, 171)); networkTitle.setPadding(dp(2), dp(12), 0, 0); settingsSection.addView(networkTitle, params(-1, 34));
        LinearLayout networkCard = new LinearLayout(this); networkCard.setOrientation(LinearLayout.VERTICAL); networkCard.setPadding(dp(14), dp(10), dp(14), dp(10)); networkCard.setBackground(box(Color.rgb(24, 30, 27), Color.rgb(42, 52, 46), dp(14)));
        TextView networkCopy = text(english ? "Same Wi‑Fi required · Received files: Downloads / Nearby Transfer" : "手机与电脑需连接同一 Wi‑Fi · 接收文件保存至：下载 / 邻传", 12, Color.rgb(177, 187, 180)); networkCopy.setLineSpacing(dp(2), 1f); networkCard.addView(networkCopy, params(-1, -2));
        View networkDivider = new View(this); networkDivider.setBackgroundColor(Color.rgb(47, 57, 51)); LinearLayout.LayoutParams dividerParams = params(-1, 1); dividerParams.setMargins(0, dp(9), 0, dp(8)); networkCard.addView(networkDivider, dividerParams);
        TextView securityNotice = text(english ? "Not encrypted — use only on a trusted local network." : "当前传输未加密，请仅在可信的局域网中使用。", 12, Color.rgb(230, 185, 105)); networkCard.addView(securityNotice, params(-1, -2)); settingsSection.addView(networkCard, params(-1, -2));

        TextView contactTitle = text(english ? "About" : "关于邻传", 14, Color.rgb(163, 185, 171)); contactTitle.setPadding(dp(2), dp(12), 0, 0); settingsSection.addView(contactTitle, params(-1, 34));
        String contactCopy = english ? "Nearby Transfer · Native Android\nBy Qi Shiyou · © 2026\nblacklaw@foxmail.com" : "邻传 Nearby Transfer · 原生 Android 应用\n作者：齐世有 · © 2026\nblacklaw@foxmail.com";
        TextView contactInfo = text(contactCopy, 12, Color.rgb(177, 187, 180)); contactInfo.setLineSpacing(dp(3), 1f); contactInfo.setPadding(dp(14), dp(10), dp(14), dp(10)); contactInfo.setBackground(box(Color.rgb(24, 30, 27), Color.rgb(42, 52, 46), dp(14))); settingsSection.addView(contactInfo, params(-1, -2));
        LinearLayout linkRow = new LinearLayout(this); linkRow.setOrientation(LinearLayout.HORIZONTAL); linkRow.setGravity(Gravity.CENTER); linkRow.setPadding(0, dp(8), 0, 0);
        LinearLayout.LayoutParams linkParams = new LinearLayout.LayoutParams(0, dp(72), 1); linkParams.setMargins(0, 0, dp(5), 0);
        linkRow.addView(linkTile("↗", "官网", "官方网站", v -> openExternal("https://linchuan.aeback.com")), linkParams);
        linkParams = new LinearLayout.LayoutParams(0, dp(72), 1); linkParams.setMargins(dp(3), 0, dp(3), 0);
        linkRow.addView(linkTile("GH", "GitHub", "项目源码", v -> openExternal("https://github.com/ShiyouQi888/Nearby-Transfer")), linkParams);
        linkParams = new LinearLayout.LayoutParams(0, dp(72), 1); linkParams.setMargins(dp(5), 0, 0, 0);
        linkRow.addView(linkTile("@", "联系作者", "发送邮件", v -> openExternal("mailto:blacklaw@foxmail.com")), linkParams);
        settingsSection.addView(linkRow, params(-1, 80));

        TextView updateTitle = text("版本更新", 14, Color.rgb(163, 185, 171)); updateTitle.setPadding(dp(2), dp(8), 0, 0); settingsSection.addView(updateTitle, params(-1, 30));
        LinearLayout updateCard = new LinearLayout(this); updateCard.setOrientation(LinearLayout.HORIZONTAL); updateCard.setGravity(Gravity.CENTER_VERTICAL); updateCard.setPadding(dp(12), dp(8), dp(10), dp(8)); updateCard.setBackground(box(Color.rgb(24, 30, 27), Color.rgb(42, 52, 46), dp(14)));
        updateStatus = text("更新源：GitHub Releases", 12, Color.rgb(177, 187, 180)); updateStatus.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); updateStatus.setMaxLines(2); updateStatus.setGravity(Gravity.CENTER_VERTICAL); updateCard.addView(updateStatus, new LinearLayout.LayoutParams(0, dp(42), 1));
        updateButton = button("检查更新"); updateButton.setTextSize(12); updateButton.setMinWidth(dp(96)); updateButton.setMaxWidth(dp(132)); updateButton.setPadding(dp(10), 0, dp(10), 0); updateButton.setOnClickListener(v -> checkForUpdates()); updateCard.addView(updateButton, new LinearLayout.LayoutParams(-2, dp(42))); settingsSection.addView(updateCard, params(-1, 58));
        // 语言切换位于右上角，设置页保持内容简洁。

        pageHost = new FrameLayout(this); pageHost.setBackgroundColor(Color.rgb(15, 18, 16));
        pageHost.addView(page(connectionSection)); pageHost.addView(page(sendSection)); pageHost.addView(page(settingsSection));
        root.addView(pageHost, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout nav = new LinearLayout(this); nav.setOrientation(LinearLayout.HORIZONTAL); nav.setGravity(Gravity.CENTER); nav.setPadding(dp(12), dp(6), dp(12), dp(8)); nav.setBackgroundColor(Color.rgb(20,24,22));
        navConnect = navButton("连接"); navSend = navButton("发送"); navSettings = navButton("设置");
        navConnect.setOnClickListener(v -> showPage(0)); navSend.setOnClickListener(v -> showPage(1)); navSettings.setOnClickListener(v -> showPage(2));
        nav.addView(navConnect, new LinearLayout.LayoutParams(0, dp(52), 1)); nav.addView(navSend, new LinearLayout.LayoutParams(0, dp(52), 1)); nav.addView(navSettings, new LinearLayout.LayoutParams(0, dp(52), 1)); root.addView(nav, new LinearLayout.LayoutParams(-1, dp(68)));
        FrameLayout shell = new FrameLayout(this); shell.setBackgroundColor(Color.rgb(15, 18, 16)); shell.addView(root, new FrameLayout.LayoutParams(-1, -1));
        incomingOverlay = buildIncomingOverlay(); incomingOverlay.setVisibility(View.GONE);
        FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP); overlayParams.setMargins(dp(16), dp(130), dp(16), 0); shell.addView(incomingOverlay, overlayParams);
        setContentView(shell);
        showPage(0);
        updatePendingText();
        renderTransferHistory();
        renderPairedDevices();
        handleNotificationIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        handleNotificationIntent(intent);
    }

    private void handleNotificationIntent(Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if ("com.lantransfer.mobile.ACCEPT_INCOMING".equals(action)) {
            if (client != null) { client.acceptIncomingOffer(); hideIncomingOverlay(); receiveText.setText(english ? "Receiving files…" : "正在接收文件…"); toast(english ? "Receiving files" : "已确认接收文件"); }
            else toast(english ? "This transfer session has expired. Ask the sender to retry." : "传输连接已失效，请让发送方重新发送");
        } else if ("com.lantransfer.mobile.REJECT_INCOMING".equals(action)) {
            if (client != null) { client.rejectIncomingOffer(); hideIncomingOverlay(); receiveText.setText(english ? "Transfer declined" : "已拒绝本次传输"); toast(english ? "Transfer declined" : "已拒绝接收"); }
            else toast(english ? "This transfer session has expired." : "传输连接已失效");
        }
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
        for (int i = 0; i < nav.length; i++) if (nav[i] != null) { nav[i].setTextColor(i == index ? Color.rgb(0, 232, 135) : Color.rgb(163, 167, 164)); nav[i].setSelected(i == index); nav[i].setBackground(i == index ? box(Color.rgb(17, 45, 32), Color.rgb(23, 92, 60), dp(12)) : new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT)); }
    }

    private void connect() {
        String ip = ipInput.getText().toString().trim(), code = codeInput.getText().toString().trim();
        String savedToken = getPreferences(MODE_PRIVATE).getString("paired_host:" + ip, "");
        if (ip.isEmpty() || (code.length() != 6 && savedToken.isEmpty())) { toast("请输入电脑 IP 和 6 位匹配码，或选择已配对设备"); return; }
        connectButton.setEnabled(false); status.setText(tr("正在连接…"));
        client = createClient(); if (code.length() == 6) client.connect(ip, NativeClient.PORT, code); else client.connectPaired(ip, NativeClient.PORT, savedToken);
    }

    private NativeClient createClient() { if (client != null) client.close(); client = new NativeClient(deviceId, deviceName(), this, english); return client; }

    private String deviceName() { return getSharedPreferences("nearby_transfer_identity", MODE_PRIVATE).getString("device_name", english ? "My phone" : "我的手机"); }

    private void scanDevices() {
        if (discovery == null || scanDevicesButton == null) return;
        scanDevicesButton.setEnabled(false); scanDevicesButton.setText(tr("正在扫描局域网…")); discoveredDevices.removeAllViews();
        discovery.scan(found -> {
            if (isFinishing() || isDestroyed()) return;
            scanDevicesButton.setEnabled(true); scanDevicesButton.setText(tr("重新扫描"));
            if (found.isEmpty()) { TextView empty = text("未发现设备，请确认同一 Wi‑Fi 且允许局域网通信", 13, Color.rgb(163,167,164)); empty.setPadding(dp(12), dp(10), dp(12), dp(10)); discoveredDevices.addView(empty); return; }
            for (org.json.JSONObject device : found.values()) {
                String ip = device.optString("ip"), name = device.optString("name", "电脑");
                String serverId = device.optString("deviceId", ""); SharedPreferences pairingPrefs = getPreferences(MODE_PRIVATE);
                String savedToken = pairingPrefs.getString("paired_host:" + ip, pairingPrefs.getString("paired_device:" + serverId, ""));
                Button row = button(name + "  ·  " + ip + (!savedToken.isEmpty() ? "  ·  " + (english ? "Trusted" : "已配对") : ""));
                row.setTextColor(Color.WHITE); row.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(12))); row.setOnClickListener(v -> { ipInput.setText(ip); String token = pairingPrefs.getString("paired_host:" + ip, pairingPrefs.getString("paired_device:" + serverId, "")); if (!token.isEmpty()) { pairingPrefs.edit().putString("paired_host:" + ip, token).putString("paired_host_device:" + ip, serverId).putString("paired_host_name:" + ip, name).apply(); renderPairedDevices(); connectButton.setEnabled(false); status.setText(tr("正在连接…")); client = createClient(); client.connectPaired(ip, NativeClient.PORT, token); } else { codeInput.requestFocus(); toast(english ? "Enter the pairing code shown on the computer" : "请输入电脑端显示的匹配码"); } });
                discoveredDevices.addView(row, params(-1, 50));
            }
        });
    }

    private void scanQr() {
        ScanOptions options = new ScanOptions(); options.setDesiredBarcodeFormats(ScanOptions.QR_CODE); options.setPrompt(english ? "Place the computer QR code inside the square frame" : "将电脑端二维码放入正方形取景框"); options.setBeepEnabled(false); options.setOrientationLocked(true);
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
            connectButton.setEnabled(false); status.setText(tr("正在扫码配对…"));
            ipInput.setText(ip); client = createClient(); client.connectWithQr(ip, port, token); return true;
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
        sendInProgress = true; status.setText(english ? "Preparing files…" : "正在准备文件…"); updateSendButtonState(); client.sendFiles(getContentResolver(), selected); updatePendingText();
    }

    private void updatePendingText() {
        int selected = 0;
        for (CheckBox check : pendingChecks) if (check.isChecked()) selected++;
        if (pendingText != null) pendingText.setText(pendingUris.isEmpty() ? tr("待发送区：暂无文件") : (english ? "Queue: " + pendingUris.size() + " file(s), " + selected + " selected" : "待发送区：" + pendingUris.size() + " 个文件，已勾选 " + selected + " 个"));
        if (pendingList == null) return;
        java.util.HashSet<String> renderedUris = new java.util.HashSet<>();
        java.util.HashSet<String> selectedUris = new java.util.HashSet<>();
        for (CheckBox check : pendingChecks) if (check.getTag() instanceof Uri) { renderedUris.add(check.getTag().toString()); if (check.isChecked()) selectedUris.add(check.getTag().toString()); }
        pendingList.removeAllViews(); pendingChecks.clear();
        for (Uri uri : pendingUris) {
            String fileName = displayName(uri), fileSize = fileSizeLabel(uri);
            LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(8), 0, dp(6), 0);
            FrameLayout preview = new FrameLayout(this); preview.setBackground(box(Color.rgb(19, 37, 29), Color.rgb(42, 75, 57), dp(9)));
            TextView typeGlyph = text(fileTypeGlyph(fileName), 10, Color.rgb(0, 232, 135)); typeGlyph.setGravity(Gravity.CENTER); preview.addView(typeGlyph, new FrameLayout.LayoutParams(-1, -1));
            ImageView thumbnail = new ImageView(this); thumbnail.setScaleType(ImageView.ScaleType.CENTER_CROP); thumbnail.setTag(uri); preview.addView(thumbnail, new FrameLayout.LayoutParams(-1, -1));
            row.addView(preview, new LinearLayout.LayoutParams(dp(40), dp(40)));
            loadThumbnail(uri, thumbnail, typeGlyph, fileName);
            CheckBox check = new CheckBox(this);
            check.setText(fileName + "  ·  " + fileSize); check.setTextColor(Color.WHITE); check.setTextSize(13); check.setChecked(true); check.setTag(uri);
            check.setChecked(!renderedUris.contains(uri.toString()) || selectedUris.contains(uri.toString()));
            check.setPadding(dp(12), 0, dp(12), 0); check.setButtonTintList(android.content.res.ColorStateList.valueOf(Color.rgb(0, 210, 131)));
            check.setOnCheckedChangeListener((buttonView, isChecked) -> { updatePendingText(); updateSendButtonState(); });
            Button remove = new Button(this); remove.setText("×"); remove.setTextColor(Color.rgb(255, 118, 126)); remove.setTextSize(22); remove.setAllCaps(false); remove.setMinWidth(0); remove.setMinHeight(0); remove.setPadding(0, 0, 0, dp(3)); remove.setBackgroundColor(Color.TRANSPARENT); remove.setContentDescription(english ? "Remove " + fileName : "移除 " + fileName); remove.setOnClickListener(v -> { pendingUris.remove(uri); updatePendingText(); });
            row.addView(check, new LinearLayout.LayoutParams(0, dp(52), 1)); row.addView(remove, new LinearLayout.LayoutParams(dp(40), dp(48)));
            pendingChecks.add(check); pendingList.addView(row, new LinearLayout.LayoutParams(-1, dp(52)));
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

    private String fileSizeLabel(Uri uri) { try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.SIZE}, null, null, null)) { if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return android.text.format.Formatter.formatShortFileSize(this, cursor.getLong(0)); } catch (Exception ignored) {} return english ? "Size unknown" : "大小未知"; }

    private String fileTypeGlyph(String fileName) { String name = fileName.toLowerCase(java.util.Locale.ROOT); if (name.matches(".*\\.(png|jpe?g|gif|webp|heic|bmp)$")) return "IMG"; if (name.matches(".*\\.(mp4|mov|mkv|webm)$")) return "VID"; if (name.matches(".*\\.(zip|rar|7z|tar|gz)$")) return "ZIP"; if (name.matches(".*\\.(txt|md|csv|docx?|pdf|xlsx?)$")) return "DOC"; return "FILE"; }

    private void loadThumbnail(Uri uri, ImageView image, TextView fallback, String fileName) {
        String type = fileTypeGlyph(fileName);
        if (Build.VERSION.SDK_INT < 29 || (!type.equals("IMG") && !type.equals("VID"))) return;
        thumbnailExecutor.execute(() -> {
            try {
                android.graphics.Bitmap bitmap = getContentResolver().loadThumbnail(uri, new android.util.Size(dp(80), dp(80)), null);
                runOnUiThread(() -> { if (!isFinishing() && uri.equals(image.getTag())) { image.setImageBitmap(bitmap); fallback.setVisibility(View.GONE); } });
            } catch (Exception ignored) { }
        });
    }

    private void updateSendButtonState() {
        boolean selected = false;
        for (CheckBox check : pendingChecks) if (check.isChecked()) { selected = true; break; }
        if (sendButton != null) sendButton.setEnabled(selected && !sendInProgress && client != null && client.isConnected());
    }

    private void renderTransferHistory() {
        if (transferHistoryList == null) return;
        transferHistoryList.removeAllViews();
        try {
            org.json.JSONArray history = new org.json.JSONArray(getPreferences(MODE_PRIVATE).getString("transfer_history", "[]"));
            int count = Math.min(20, history.length());
            for (int i = 0; i < count; i++) {
                org.json.JSONObject item = history.getJSONObject(i);
                String direction = item.optBoolean("incoming") ? (english ? "Received" : "收到") : (english ? "Sent" : "发送");
                String result = item.optBoolean("success") ? (english ? "Complete" : "完成") : (english ? "Failed" : "失败");
                TextView row = text(direction + " · " + result + "\n" + item.optString("label") + "\n" + android.text.format.DateFormat.format("yyyy-MM-dd HH:mm", item.optLong("time")), 12, Color.rgb(163,167,164));
                row.setPadding(dp(14), dp(10), dp(14), dp(10)); row.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(10))); transferHistoryList.addView(row, params(-1, -2));
            }
            if (count == 0) { TextView empty = text("暂无传输记录", 13, Color.rgb(127,132,128)); empty.setPadding(dp(12), dp(8), dp(12), dp(8)); transferHistoryList.addView(empty); }
        } catch (Exception ignored) { }
    }

    private void renderPairedDevices() {
        if (pairedDevicesList == null) return;
        pairedDevicesList.removeAllViews();
        SharedPreferences prefs = getPreferences(MODE_PRIVATE); java.util.Map<String, ?> all = prefs.getAll();
        boolean found = false;
        for (java.util.Map.Entry<String, ?> entry : all.entrySet()) {
            String key = entry.getKey(); if (!key.startsWith("paired_host:") || key.startsWith("paired_host_device:") || key.startsWith("paired_host_name:")) continue;
            String host = key.substring("paired_host:".length()); if (!(entry.getValue() instanceof String) || ((String) entry.getValue()).isEmpty()) continue;
            found = true; String serverId = prefs.getString("paired_host_device:" + host, ""); String name = prefs.getString("paired_host_name:" + host, english ? "Computer" : "电脑"); String token = (String) entry.getValue();
            LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(12), dp(4), dp(6), dp(4)); row.setBackground(box(Color.rgb(25,30,27), Color.rgb(42,47,45), dp(12)));
            TextView identity = text(name + "\n" + host, 13, Color.WHITE); identity.setGravity(Gravity.CENTER_VERTICAL); row.addView(identity, new LinearLayout.LayoutParams(0, dp(54), 1));
            Button connectSaved = button(english ? "Connect" : "连接"); connectSaved.setTextSize(12); connectSaved.setOnClickListener(v -> { ipInput.setText(host); client = createClient(); connectButton.setEnabled(false); status.setText(tr("正在连接…")); client.connectPaired(host, NativeClient.PORT, token); }); row.addView(connectSaved, new LinearLayout.LayoutParams(dp(88), dp(42)));
            Button remove = new Button(this); remove.setText("×"); remove.setContentDescription(english ? "Remove trusted device " + name : "删除可信设备 " + name); remove.setTextColor(Color.rgb(255,118,126)); remove.setTextSize(22); remove.setBackgroundColor(Color.TRANSPARENT); remove.setOnClickListener(v -> removePairedDevice(host, serverId)); row.addView(remove, new LinearLayout.LayoutParams(dp(40), dp(44)));
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2); rowParams.setMargins(0, dp(4), 0, dp(4)); pairedDevicesList.addView(row, rowParams);
        }
        if (!found) { TextView empty = text("暂无历史设备，首次连接后会自动保存", 13, Color.rgb(127,132,128)); empty.setPadding(dp(12), dp(8), dp(12), dp(8)); pairedDevicesList.addView(empty); }
    }

    private void removePairedDevice(String host, String serverId) {
        SharedPreferences prefs = getPreferences(MODE_PRIVATE); SharedPreferences.Editor editor = prefs.edit();
        if (serverId != null && !serverId.isEmpty()) {
            for (String key : prefs.getAll().keySet()) if (key.startsWith("paired_host_device:") && serverId.equals(prefs.getString(key, ""))) { String mappedHost = key.substring("paired_host_device:".length()); editor.remove("paired_host:" + mappedHost).remove("paired_host_device:" + mappedHost).remove("paired_host_name:" + mappedHost); }
            editor.remove("paired_device:" + serverId);
        } else editor.remove("paired_host:" + host).remove("paired_host_device:" + host).remove("paired_host_name:" + host);
        editor.apply(); renderPairedDevices();
    }

    private void recordTransfer(boolean incoming, String label, boolean success) {
        try {
            SharedPreferences prefs = getPreferences(MODE_PRIVATE); org.json.JSONArray old = new org.json.JSONArray(prefs.getString("transfer_history", "[]")); org.json.JSONArray next = new org.json.JSONArray();
            next.put(new org.json.JSONObject().put("incoming", incoming).put("label", label).put("success", success).put("time", System.currentTimeMillis()));
            for (int i = 0; i < old.length() && i < 19; i++) next.put(old.getJSONObject(i));
            prefs.edit().putString("transfer_history", next.toString()).apply(); runOnUiThread(this::renderTransferHistory);
        } catch (Exception ignored) { }
    }

    private Button compactLanguageButton() {
        Button b = new Button(this); b.setText(english ? "中" : "EN"); b.setTextSize(12); b.setTextColor(Color.rgb(0, 232, 135)); b.setAllCaps(false); b.setMinHeight(0); b.setMinWidth(0); b.setPadding(0, 0, 0, 0); b.setBackground(box(Color.rgb(25, 38, 31), Color.rgb(0, 210, 131), dp(10))); b.setContentDescription(english ? "切换到中文" : "Switch to English"); b.setOnClickListener(v -> { getPreferences(MODE_PRIVATE).edit().putBoolean("english", !english).apply(); recreate(); }); return b;
    }

    private FrameLayout buildIncomingOverlay() {
        FrameLayout overlay = new FrameLayout(this); overlay.setPadding(dp(16), dp(14), dp(16), dp(14)); overlay.setBackground(box(Color.rgb(23, 31, 27), Color.rgb(0, 210, 131), dp(16))); overlay.setElevation(dp(12));
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        TextView title = text("收到文件", 17, Color.WHITE); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); body.addView(title, new LinearLayout.LayoutParams(-1, dp(28)));
        incomingOverlayText = text("收到文件，请选择接收或拒绝", 13, Color.rgb(163, 167, 164)); incomingOverlayText.setLineSpacing(dp(2), 1f); ScrollView details = new ScrollView(this); details.setFillViewport(false); details.setVerticalScrollBarEnabled(true); details.addView(incomingOverlayText, new ScrollView.LayoutParams(-1, -2)); body.addView(details, new LinearLayout.LayoutParams(-1, dp(96)));
        LinearLayout actions = new LinearLayout(this); actions.setOrientation(LinearLayout.HORIZONTAL); actions.setGravity(Gravity.CENTER_VERTICAL);
        Button reject = button("拒绝接收"); reject.setTextColor(Color.WHITE); reject.setBackground(box(Color.rgb(31,36,33), Color.rgb(180,70,80), dp(10))); reject.setOnClickListener(v -> { if (client != null) client.rejectIncomingOffer(); hideIncomingOverlay(); receiveActions.setVisibility(View.GONE); });
        Button accept = button("确认接收"); accept.setOnClickListener(v -> { if (client != null) client.acceptIncomingOffer(); hideIncomingOverlay(); receiveActions.setVisibility(View.GONE); });
        actions.addView(reject, new LinearLayout.LayoutParams(0, dp(46), 1)); actions.addView(accept, new LinearLayout.LayoutParams(0, dp(46), 1)); body.addView(actions, new LinearLayout.LayoutParams(-1, dp(52)));
        overlay.addView(body, new FrameLayout.LayoutParams(-1, -2)); return overlay;
    }

    private void showIncomingOverlay(String label, String deviceName, String ip) {
        if (incomingOverlayText != null) incomingOverlayText.setText(english ? "From: " + deviceName + "\nIP: " + ip + "\nFile: " + label : "来源设备：" + deviceName + "\nIP 地址：" + ip + "\n文件：" + label);
        if (incomingOverlay != null) incomingOverlay.setVisibility(View.VISIBLE);
    }

    private void hideIncomingOverlay() { if (incomingOverlay != null) incomingOverlay.setVisibility(View.GONE); }

    private Button navButton(String label) {
        Button b = button(label); b.setTextColor(Color.rgb(163, 167, 164)); b.setBackgroundColor(Color.TRANSPARENT); return b;
    }

    private LinearLayout linkTile(String glyph, String label, String subtitle, View.OnClickListener listener) {
        LinearLayout tile = new LinearLayout(this); tile.setOrientation(LinearLayout.VERTICAL); tile.setGravity(Gravity.CENTER); tile.setPadding(dp(4), dp(2), dp(4), dp(2));
        tile.setBackground(box(Color.rgb(24, 31, 27), Color.rgb(47, 65, 55), dp(16))); tile.setClickable(true); tile.setFocusable(true); tile.setContentDescription(label); tile.setOnClickListener(listener); tile.setElevation(dp(2));
        LinearLayout iconWrap = new LinearLayout(this); iconWrap.setGravity(Gravity.CENTER); iconWrap.setBackground(box(Color.rgb(7, 73, 45), Color.rgb(0, 210, 131), dp(20)));
        TextView icon = text(glyph, glyph.equals("GH") ? 13 : 18, Color.rgb(0, 240, 145)); icon.setGravity(Gravity.CENTER); icon.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); iconWrap.addView(icon, new LinearLayout.LayoutParams(-1, -1));
        tile.addView(iconWrap, new LinearLayout.LayoutParams(dp(28), dp(28)));
        TextView title = text(label, 11, Color.WHITE); title.setGravity(Gravity.CENTER); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); tile.addView(title, new LinearLayout.LayoutParams(-1, dp(20)));
        return tile;
    }

    private void openExternal(String uri) {
        try { startActivity(new Intent(uri.startsWith("mailto:") ? Intent.ACTION_SENDTO : Intent.ACTION_VIEW, Uri.parse(uri))); }
        catch (Exception ignored) { toast("无法打开链接，请检查系统应用"); }
    }

    private void checkForUpdates() {
        if (updateButton == null || updateStatus == null) return;
        updateButton.setEnabled(false); updateStatus.setText("正在检查 GitHub Releases…");
        new Thread(() -> {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL("https://api.github.com/repos/ShiyouQi888/Nearby-Transfer/releases/latest").openConnection();
                connection.setRequestMethod("GET"); connection.setConnectTimeout(10000); connection.setReadTimeout(10000); connection.setRequestProperty("Accept", "application/vnd.github+json"); connection.setRequestProperty("User-Agent", "Nearby-Transfer-Android");
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new Exception("GitHub Releases 暂不可用");
                StringBuilder raw = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) { String line; while ((line = reader.readLine()) != null) raw.append(line); }
                org.json.JSONObject release = new org.json.JSONObject(raw.toString());
                String latest = release.optString("tag_name", "").replaceFirst("^[vV]", ""); String releaseUrl = release.optString("html_url", "https://github.com/ShiyouQi888/Nearby-Transfer/releases"); String apkUrl = releaseUrl;
                org.json.JSONArray assets = release.optJSONArray("assets");
                if (assets != null) for (int i = 0; i < assets.length(); i++) { org.json.JSONObject asset = assets.optJSONObject(i); if (asset != null && asset.optString("name").toLowerCase(java.util.Locale.ROOT).endsWith(".apk")) { apkUrl = asset.optString("browser_download_url", releaseUrl); break; } }
                final String version = latest, downloadUrl = apkUrl;
                runOnUiThread(() -> {
                    updateButton.setEnabled(true);
                    if (compareVersions(version, appVersion()) > 0) { updateStatus.setText("发现新版本 v" + version); updateButton.setText("下载新版 APK"); updateButton.setOnClickListener(v -> openExternal(downloadUrl)); }
                    else { updateStatus.setText("当前已是最新版本 v" + appVersion()); updateButton.setText("重新检查"); updateButton.setOnClickListener(v -> checkForUpdates()); }
                });
            } catch (Exception error) { runOnUiThread(() -> { updateButton.setEnabled(true); updateStatus.setText("暂时无法检查更新，请稍后重试"); updateButton.setText("重新检查"); }); }
        }).start();
    }

    private int compareVersions(String left, String right) {
        String[] a = String.valueOf(left).split("\\."), b = String.valueOf(right).split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) { int x = i < a.length ? parseVersionPart(a[i]) : 0, y = i < b.length ? parseVersionPart(b[i]) : 0; if (x != y) return x - y; }
        return 0;
    }

    private int parseVersionPart(String value) { try { return Integer.parseInt(value.replaceAll("[^0-9].*", "")); } catch (Exception ignored) { return 0; } }

    private String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception ignored) { return "1.0.3"; }
    }

    private String tr(String value) {
        if (!english || value == null) return value;
        switch (value) {
            case "邻传": return "Nearby Transfer";
            case "局域网高速互传": return "Fast LAN Transfer";
            case "未连接": return "Not connected";
            case "连接电脑": return "Connect computer";
            case "电脑 IP，例如 192.168.1.23": return "Computer IP, e.g. 192.168.1.23";
            case "6 位匹配码": return "6-digit pairing code";
            case "使用匹配码连接": return "Connect with pairing code";
            case "扫描电脑二维码": return "Scan computer QR code";
            case "发送文件": return "Send files";
            case "选择文件": return "Choose files";
            case "选择文件（加入待发送）": return "Choose files to queue";
            case "待发送区：暂无文件": return "Queue: no files";
            case "发送已勾选文件": return "Send selected files";
            case "接收区：暂无文件": return "Receive: no files";
            case "拒绝接收": return "Reject";
            case "确认接收": return "Accept";
            case "设置": return "Settings";
            case "连接": return "Connect";
            case "发送": return "Send";
            case "原生 Android 应用": return "Native Android app";
            case "关于与联系": return "About & contact";
            case "快捷入口": return "Quick links";
            case "点击图标访问相关页面": return "Tap an icon to open a link";
            case "官网": return "Website";
            case "官方网站": return "Official website";
            case "GitHub": return "GitHub";
            case "项目源码": return "Source code";
            case "联系作者": return "Contact author";
            case "发送邮件": return "Send email";
            case "版本更新": return "Updates";
            case "更新源：GitHub Releases": return "Source: GitHub Releases";
            case "检查更新": return "Check for updates";
            case "语言：简体中文": return "Language: English";
            case "已连接": return "Connected";
            case "连接失败": return "Connection failed";
            case "连接已断开": return "Disconnected";
            case "二维码内容无法识别": return "QR code not recognized";
            case "请输入电脑 IP 和 6 位匹配码": return "Enter the computer IP and 6-digit pairing code";
            case "正在连接…": return "Connecting…";
            case "正在扫码配对…": return "Pairing by QR code…";
            case "扫描局域网设备": return "Scan local network";
            case "正在扫描局域网…": return "Scanning local network…";
            case "重新扫描": return "Scan again";
            case "设备名称": return "Device name";
            case "保存设备名称": return "Save device name";
            case "历史设备": return "Trusted devices";
            case "最近传输": return "Recent transfers";
            case "清空记录": return "Clear history";
            case "暂无传输记录": return "No transfer history";
            case "暂无历史设备，首次连接后会自动保存": return "No trusted devices yet. Devices are saved after pairing.";
            case "安全提示": return "Security note";
            case "请先勾选要发送的文件": return "Select at least one file";
            case "请先连接电脑，再发送待选文件": return "Connect to the computer before sending";
            case "无法打开文件选择器，请检查系统文件应用": return "Unable to open the file picker";
            case "无法打开链接，请检查系统应用": return "Unable to open the link";
            case "收到文件，请选择接收或拒绝": return "Files received; choose accept or reject";
            default: return value;
        }
    }

    @Override public void onConnected(String name) { runOnUiThread(() -> { status.setText((english ? "Connected · " : "已连接 · ") + name); connectButton.setEnabled(true); connectButton.setText(tr("已连接")); pickButton.setText(tr("选择文件")); updateSendButtonState(); }); }
    @Override public void onConnectionDetails(String name, String serverId, String token, String host) { SharedPreferences prefs = getPreferences(MODE_PRIVATE); SharedPreferences.Editor editor = prefs.edit(); if (host != null && !host.isEmpty()) { if (token != null && !token.isEmpty()) editor.putString("paired_host:" + host, token); if (serverId != null && !serverId.isEmpty()) { editor.putString("paired_host_device:" + host, serverId); if (token != null && !token.isEmpty()) editor.putString("paired_device:" + serverId, token); } editor.putString("paired_host_name:" + host, name); } editor.putString("last_connect_name", name); editor.apply(); runOnUiThread(this::renderPairedDevices); }
    @Override public void onError(String message) { runOnUiThread(() -> { if (message != null && (message.contains("匹配凭证已失效") || message.contains("Pairing token expired"))) { String ip = ipInput.getText().toString().trim(); SharedPreferences.Editor editor = getPreferences(MODE_PRIVATE).edit().remove("paired_host:" + ip); String serverId = getPreferences(MODE_PRIVATE).getString("paired_host_device:" + ip, ""); if (!serverId.isEmpty()) editor.remove("paired_device:" + serverId).remove("paired_host_device:" + ip); editor.apply(); codeInput.requestFocus(); } status.setText(tr("连接失败")); connectButton.setEnabled(true); updateSendButtonState(); toast(message); }); }
    @Override public void onRejected(String reason) { runOnUiThread(() -> { status.setText(english ? "Transfer rejected by the computer" : "电脑已拒绝接收"); toast(english ? "The recipient declined this transfer" : "对方拒绝了本次文件传输"); }); }
    @Override public void onSendWaiting(List<Uri> files) { runOnUiThread(() -> { sendInProgress = true; status.setText(english ? "Waiting for recipient approval" : "等待电脑确认接收"); updateSendButtonState(); }); }
    @Override public void onSendAccepted(List<Uri> files) { runOnUiThread(() -> { pendingUris.removeAll(files); updatePendingText(); status.setText(english ? "Sending files…" : "正在发送文件…"); }); }
    @Override public void onSendFailed(List<Uri> files, String error) { runOnUiThread(() -> { for (Uri uri : files) if (!pendingUris.contains(uri)) pendingUris.add(uri); sendInProgress = false; updatePendingText(); updateSendButtonState(); }); }
    @Override public void onSendRejected(List<Uri> files) { runOnUiThread(() -> { sendInProgress = false; updatePendingText(); updateSendButtonState(); }); }
    @Override public void onTransferFinished(boolean incoming, String label, boolean success) { if (!incoming) runOnUiThread(() -> { sendInProgress = false; updateSendButtonState(); }); recordTransfer(incoming, label, success); }
    @Override public void onClosed() { runOnUiThread(() -> { status.setText(tr("连接已断开")); connectButton.setEnabled(true); pickButton.setText(tr("选择文件")); updateSendButtonState(); }); }
    @Override public void onIncomingOffer(String label, String deviceName, String ip) { runOnUiThread(() -> { status.setText(english ? "Waiting for confirmation" : "等待接收确认"); receiveText.setText(english ? "From: " + deviceName + " · " + ip + "\nFiles: " + label : "来源：" + deviceName + " · " + ip + "\n文件：" + label); showIncomingOverlay(label, deviceName, ip); toast(english ? "Incoming files · review and accept or decline" : "收到文件，请确认接收或拒绝"); showIncomingNotification(label, deviceName, ip); }); }

    private void createNotificationChannel() { if (Build.VERSION.SDK_INT >= 26) { NotificationChannel c = new NotificationChannel("transfer", english ? "File transfers" : "文件传输", NotificationManager.IMPORTANCE_DEFAULT); getSystemService(NotificationManager.class).createNotificationChannel(c); } }
    private void showIncomingNotification(String label, String deviceName, String ip) { if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 77); return; } int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0); Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); PendingIntent openAction = PendingIntent.getActivity(this, 77, open, flags); Intent accept = new Intent(this, MainActivity.class).setAction("com.lantransfer.mobile.ACCEPT_INCOMING").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); Intent reject = new Intent(this, MainActivity.class).setAction("com.lantransfer.mobile.REJECT_INCOMING").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); PendingIntent acceptAction = PendingIntent.getActivity(this, 78, accept, flags); PendingIntent rejectAction = PendingIntent.getActivity(this, 79, reject, flags); android.app.Notification.Builder notification = new android.app.Notification.Builder(this, "transfer").setSmallIcon(com.lantransfer.mobile.R.mipmap.ic_launcher).setContentTitle(english ? "Incoming files · Nearby Transfer" : "邻传收到文件").setContentText((english ? "From " : "来自 ") + deviceName + " · " + ip + " · " + label).setContentIntent(openAction).setAutoCancel(true).addAction(0, english ? "Decline" : "拒绝", rejectAction).addAction(0, english ? "Accept" : "接收", acceptAction); NotificationManager n = (NotificationManager) getSystemService(NOTIFICATION_SERVICE); n.notify(77, notification.build()); }
    @Override public void onProgress(int percent) { onProgress(percent, false); }
    @Override public void onProgress(int percent, boolean receiving) { runOnUiThread(() -> status.setText(english ? (receiving ? "Receiving " : "Sending ") + percent + "%" : (receiving ? "正在接收 " : "正在发送 ") + percent + "%")); }
    @Override protected void onDestroy() { if (client != null) client.close(); if (discovery != null) discovery.stop(); thumbnailExecutor.shutdownNow(); super.onDestroy(); }

    private TextView text(String value, int size, int color) { TextView v = new TextView(this); v.setText(tr(value)); v.setTextSize(size); v.setTextColor(color); v.setBackgroundColor(Color.TRANSPARENT); return v; }
    private EditText input(String hint) { EditText v = new EditText(this); v.setHint(tr(hint)); v.setHintTextColor(Color.rgb(127,132,128)); v.setTextColor(Color.WHITE); v.setTextSize(15); v.setSingleLine(true); v.setPadding(dp(16), 0, dp(16), 0); v.setBackground(box(Color.rgb(31,36,33), Color.rgb(42,47,45), dp(12))); return v; }
    private Button button(String label) { Button b = new Button(this); b.setText(tr(label)); b.setTextSize(15); b.setTextColor(Color.rgb(7,26,18)); b.setAllCaps(false); b.setPadding(dp(12), 0, dp(12), 0); b.setBackground(box(Color.rgb(7,193,96), Color.rgb(7,193,96), dp(12))); return b; }
    private GradientDrawable box(int fill, int stroke, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(fill); d.setCornerRadius(radius); d.setStroke(dp(1), stroke); return d; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout.LayoutParams params(int width, int height) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(width, dp(height)); p.setMargins(0, dp(6), 0, dp(6)); return p; }
    private String localizeError(String message) {
        if (!english || message == null) return tr(message);
        if (message.startsWith("无法读取文件：")) return "Cannot read file: " + message.substring("无法读取文件：".length());
        if (message.startsWith("接收准备失败：")) return "Unable to prepare received files: " + message.substring("接收准备失败：".length());
        if (message.startsWith("连接电脑超时：")) return "Computer connection timed out: " + message.substring("连接电脑超时：".length());
        if (message.startsWith("连接失败：")) return "Connection failed: " + message.substring("连接失败：".length());
        if (message.startsWith("电脑端未接受连接")) return "The computer refused the connection. Check that Nearby Transfer is running and port 53317 is allowed through the firewall.";
        if (message.startsWith("设备未配对")) return "Device is not paired. Enter the pairing code on the computer or scan its QR code.";
        if (message.startsWith("匹配凭证已失效")) return "Pairing token expired. Please pair again.";
        if (message.equals("发送失败")) return "Sending failed";
        return tr(message);
    }

    private void toast(String message) { Toast.makeText(this, localizeError(message), Toast.LENGTH_LONG).show(); }
}
