package com.lantransfer.mobile;

import android.content.Intent;
import android.util.Base64;
import android.graphics.Color;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
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
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.graphics.Typeface;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.OnBackPressedCallback;
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
    private static final int PICK_CHAT_FILE = 43;
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
    private LinearLayout connectionSection, sendSection, settingsSection, chatSection;
    private FrameLayout pageHost;
    private LinearLayout bottomNav;
    private OnBackPressedCallback chatBackCallback;
    private int activePageIndex;
    private Button navConnect, navSend, navSettings, navChat;
    // ── 聊天 ──
    private ChatStore chatStore;
    private LinearLayout chatList;
    private ScrollView chatScroll;
    private TextView chatHint, chatEmpty, chatPeerName, chatConnectionLabel;
    private View chatOnlineDot;
    private EditText chatInput;
    private Button chatSendButton;
    /** 与当前对端已读位点（本地视角）。 */
    private long chatReadUpTo = 0;
    /** 聊天文件进度：transferId -> 对应的气泡 View，用于就地刷新进度。 */
    private final java.util.Map<String, TextView> chatProgressViews = new java.util.HashMap<>();
    private final java.util.Map<String, ProgressBar> chatProgressBars = new java.util.HashMap<>();
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
    private TextView incomingDeviceText, incomingIpText;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        SharedPreferences identity = getSharedPreferences("nearby_transfer_identity", MODE_PRIVATE);
        deviceId = identity.getString("device_id", null);
        if (deviceId == null || deviceId.trim().isEmpty()) {
            deviceId = "mobile-" + UUID.randomUUID().toString().replace("-", "");
            identity.edit().putString("device_id", deviceId).apply();
        }
        english = getPreferences(MODE_PRIVATE).getBoolean("english", false);
        chatStore = new ChatStore(this);
        if (!identity.contains("device_name")) identity.edit().putString("device_name", english ? "My phone" : "我的手机").apply();
        getWindow().setStatusBarColor(Color.rgb(15, 18, 16));
        createNotificationChannel();
        NativeDiscovery.AppContextHolder.context = getApplicationContext();
        discovery = new NativeDiscovery(deviceId);
        discovery.start();
        qrLauncher = registerForActivityResult(new ScanContract(), result -> { if (result.getContents() != null && !connectFromQr(result.getContents())) toast("二维码内容无法识别"); });
        buildUi();
        chatBackCallback = new OnBackPressedCallback(false) {
            @Override public void handleOnBackPressed() { showPage(0); }
        };
        getOnBackPressedDispatcher().addCallback(this, chatBackCallback);
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

        chatSection = new LinearLayout(this); chatSection.setOrientation(LinearLayout.VERTICAL);
        chatSection.setPadding(dp(20), dp(4), dp(20), 0);
        LinearLayout chatHeader = new LinearLayout(this); chatHeader.setOrientation(LinearLayout.HORIZONTAL); chatHeader.setGravity(Gravity.CENTER_VERTICAL);
        Button chatBack = new Button(this); chatBack.setText("‹"); chatBack.setTextSize(30); chatBack.setAllCaps(false); chatBack.setTextColor(Color.WHITE); chatBack.setContentDescription(english ? "Back to pages" : "返回主页面"); chatBack.setPadding(0, 0, 0, dp(3)); chatBack.setBackgroundColor(Color.TRANSPARENT); chatBack.setOnClickListener(v -> showPage(0));
        LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(dp(34), dp(48)); backParams.setMargins(dp(-8), 0, dp(4), 0); chatHeader.addView(chatBack, backParams);
        View peerAvatar = new DeviceAvatar(false);
        chatHeader.addView(peerAvatar, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout peerInfo = new LinearLayout(this); peerInfo.setOrientation(LinearLayout.VERTICAL); peerInfo.setPadding(dp(11), 0, 0, 0);
        chatPeerName = text(english ? "Paired computer" : "已配对的电脑", 16, Color.WHITE); chatPeerName.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        peerInfo.addView(chatPeerName, new LinearLayout.LayoutParams(-1, dp(24)));
        LinearLayout connectionLine = new LinearLayout(this); connectionLine.setOrientation(LinearLayout.HORIZONTAL); connectionLine.setGravity(Gravity.CENTER_VERTICAL);
        chatOnlineDot = new View(this); chatOnlineDot.setBackground(box(Color.rgb(0, 220, 130), Color.rgb(0, 220, 130), dp(6))); connectionLine.addView(chatOnlineDot, new LinearLayout.LayoutParams(dp(7), dp(7)));
        chatConnectionLabel = text(english ? "Local network · private chat" : "局域网连接 · 私密对话", 11, Color.rgb(145, 163, 151));
        LinearLayout.LayoutParams connectionLabelParams = new LinearLayout.LayoutParams(-2, dp(20)); connectionLabelParams.leftMargin = dp(6); connectionLine.addView(chatConnectionLabel, connectionLabelParams);
        peerInfo.addView(connectionLine, new LinearLayout.LayoutParams(-1, dp(20)));
        chatHeader.addView(peerInfo, new LinearLayout.LayoutParams(0, -2, 1));
        chatSection.addView(chatHeader, new LinearLayout.LayoutParams(-1, dp(58)));

        chatHint = text(english ? "Messages stay on your local network — no cloud relay." : "消息仅通过本地局域网传输，不经过云端。", 11, Color.rgb(127, 145, 134)); chatHint.setPadding(dp(55), 0, 0, dp(8)); chatSection.addView(chatHint, new LinearLayout.LayoutParams(-1, dp(30)));
        View headerDivider = new View(this); headerDivider.setBackgroundColor(Color.rgb(38, 46, 41)); chatSection.addView(headerDivider, new LinearLayout.LayoutParams(-1, dp(1)));

        FrameLayout timeline = new FrameLayout(this);
        chatScroll = new ScrollView(this); chatScroll.setFillViewport(true); chatScroll.setClipToPadding(false); chatScroll.setVerticalScrollBarEnabled(false);
        chatList = new LinearLayout(this); chatList.setOrientation(LinearLayout.VERTICAL); chatList.setPadding(0, dp(12), 0, dp(14));
        chatScroll.addView(chatList, new ScrollView.LayoutParams(-1, -2));
        timeline.addView(chatScroll, new FrameLayout.LayoutParams(-1, -1));
        chatEmpty = text(english ? "No messages yet\nSend a message to start the conversation." : "还没有消息\n发送一条消息，开始你们的对话。", 13, Color.rgb(127, 145, 134)); chatEmpty.setGravity(Gravity.CENTER); chatEmpty.setTextAlignment(View.TEXT_ALIGNMENT_CENTER); chatEmpty.setLineSpacing(dp(6), 1f); chatEmpty.setPadding(dp(24), dp(24), dp(24), dp(24));
        timeline.addView(chatEmpty, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout.LayoutParams timelineParams = new LinearLayout.LayoutParams(-1, 0, 1); timelineParams.topMargin = dp(10); chatSection.addView(timeline, timelineParams);

        LinearLayout composer = new LinearLayout(this); composer.setOrientation(LinearLayout.HORIZONTAL); composer.setGravity(Gravity.CENTER_VERTICAL); composer.setPadding(0, 0, 0, 0);
        FrameLayout inputShell = new FrameLayout(this);
        inputShell.setBackground(box(Color.rgb(25, 30, 27), Color.rgb(48, 56, 51), dp(24)));
        chatInput = new EditText(this); chatInput.setHint(tr("输入消息…")); chatInput.setTextSize(15); chatInput.setTextColor(Color.WHITE); chatInput.setHintTextColor(Color.rgb(127,132,128));
        chatInput.setBackgroundColor(Color.TRANSPARENT); chatInput.setPadding(dp(50), dp(6), dp(50), dp(6)); chatInput.setMinHeight(dp(50)); chatInput.setGravity(Gravity.CENTER_VERTICAL | Gravity.START); chatInput.setIncludeFontPadding(false);
        chatInput.setMaxLines(4); chatInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        chatInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEND | android.view.inputmethod.EditorInfo.IME_FLAG_NO_ENTER_ACTION);
        inputShell.addView(chatInput, new FrameLayout.LayoutParams(-1, dp(52), Gravity.CENTER_VERTICAL));
        Button chatAttach = new Button(this); chatAttach.setText("＋"); chatAttach.setTextSize(23); chatAttach.setAllCaps(false); chatAttach.setTextColor(Color.rgb(0, 225, 132)); chatAttach.setContentDescription(english ? "Attach a file" : "发送文件");
        chatAttach.setMinWidth(0); chatAttach.setMinHeight(0); chatAttach.setPadding(0, 0, 0, dp(2)); chatAttach.setBackgroundColor(Color.TRANSPARENT); chatAttach.setOnClickListener(v -> pickChatFile());
        FrameLayout.LayoutParams attachParams = new FrameLayout.LayoutParams(dp(42), dp(42), Gravity.START | Gravity.CENTER_VERTICAL); attachParams.leftMargin = dp(4); inputShell.addView(chatAttach, attachParams);
        chatSendButton = new Button(this); chatSendButton.setText("➤"); chatSendButton.setTextSize(19); chatSendButton.setAllCaps(false); chatSendButton.setTextColor(Color.rgb(7, 26, 18)); chatSendButton.setContentDescription(english ? "Send message" : "发送消息");
        chatSendButton.setMinWidth(0); chatSendButton.setMinHeight(0); chatSendButton.setPadding(0, 0, 0, 0);
        chatSendButton.setBackground(box(Color.rgb(0, 205, 119), Color.rgb(0, 205, 119), dp(20))); chatSendButton.setEnabled(false); chatSendButton.setAlpha(0.45f); chatSendButton.setOnClickListener(v -> sendChatText());
        FrameLayout.LayoutParams sendParams = new FrameLayout.LayoutParams(dp(40), dp(40), Gravity.END | Gravity.CENTER_VERTICAL); sendParams.rightMargin = dp(5); inputShell.addView(chatSendButton, sendParams);
        composer.addView(inputShell, new LinearLayout.LayoutParams(-1, dp(52)));
        chatSection.addView(composer, new LinearLayout.LayoutParams(-1, -2));
        chatInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND || (event != null && event.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER && event.getAction() == android.view.KeyEvent.ACTION_DOWN && !event.isShiftPressed())) { sendChatText(); return true; }
            return false;
        });
        chatInput.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(android.text.Editable s) { if (chatSendButton != null) { boolean hasText = s.toString().trim().length() > 0; chatSendButton.setEnabled(hasText); chatSendButton.setAlpha(hasText ? 1f : 0.45f); } }
        });

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
        Button notificationSettings = button(english ? "Set up notifications" : "设置接收通知"); notificationSettings.setTextSize(13); notificationSettings.setOnClickListener(v -> showNotificationPermissionDialog());
        LinearLayout.LayoutParams notificationParams = new LinearLayout.LayoutParams(-1, dp(42)); notificationParams.topMargin = dp(8); settingsSection.addView(notificationSettings, notificationParams);

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
        pageHost.addView(page(connectionSection)); pageHost.addView(page(sendSection));
        pageHost.addView(chatSection, new FrameLayout.LayoutParams(-1, -1)); pageHost.addView(page(settingsSection));
        root.addView(pageHost, new LinearLayout.LayoutParams(-1, 0, 1));

        bottomNav = new LinearLayout(this); bottomNav.setOrientation(LinearLayout.HORIZONTAL); bottomNav.setGravity(Gravity.CENTER); bottomNav.setPadding(dp(12), dp(6), dp(12), dp(8)); bottomNav.setBackgroundColor(Color.rgb(20,24,22));
        navConnect = navButton("连接"); navSend = navButton("发送"); navChat = navButton("聊天"); navSettings = navButton("设置");
        navConnect.setOnClickListener(v -> showPage(0)); navSend.setOnClickListener(v -> showPage(1));
        navChat.setOnClickListener(v -> showPage(2)); navSettings.setOnClickListener(v -> showPage(3));
        bottomNav.addView(navConnect, new LinearLayout.LayoutParams(0, dp(52), 1)); bottomNav.addView(navSend, new LinearLayout.LayoutParams(0, dp(52), 1));
        bottomNav.addView(navChat, new LinearLayout.LayoutParams(0, dp(52), 1)); bottomNav.addView(navSettings, new LinearLayout.LayoutParams(0, dp(52), 1)); root.addView(bottomNav, new LinearLayout.LayoutParams(-1, dp(68)));
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
        activePageIndex = index;
        if (bottomNav != null) bottomNav.setVisibility(View.VISIBLE);
        if (chatBackCallback != null) chatBackCallback.setEnabled(index == 2);
        for (int i = 0; i < pageHost.getChildCount(); i++) pageHost.getChildAt(i).setVisibility(i == index ? View.VISIBLE : View.GONE);
        Button[] nav = { navConnect, navSend, navChat, navSettings };
        for (int i = 0; i < nav.length; i++) if (nav[i] != null) { nav[i].setTextColor(i == index ? Color.rgb(0, 232, 135) : Color.rgb(163, 167, 164)); nav[i].setSelected(i == index); nav[i].setBackground(i == index ? box(Color.rgb(17, 45, 32), Color.rgb(23, 92, 60), dp(12)) : new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT)); }
        // 进入聊天页时刷新一次，并把对端消息标记为已读。
        if (index == 2) { renderChat(); }
    }

    // ─────────────────────────────────────────────────────────────
    // 聊天（Chat over LTP/1）
    // ─────────────────────────────────────────────────────────────

    /** 当前聊天对端的稳定标识：优先用已配对设备的 deviceId，否则退回 IP。 */
    private String chatPeerKey() {
        String host = ipInput != null ? ipInput.getText().toString().trim() : "";
        if (host.isEmpty()) host = getPreferences(MODE_PRIVATE).getString("last_host", "");
        return host.isEmpty() ? "unknown" : "host-" + host;
    }

    /** 本地已读位点（每个对端独立）。 */
    private long readPref(String peer) { return getPreferences(MODE_PRIVATE).getLong("chat_read_" + peer, 0); }
    private void setReadPref(String peer, long ts) { getPreferences(MODE_PRIVATE).edit().putLong("chat_read_" + peer, ts).apply(); }

    private void renderChat() {
        if (chatList == null) return;
        updateChatHeader();
        String peer = chatPeerKey();
        chatList.removeAllViews();
        chatProgressViews.clear();
        chatProgressBars.clear();
        java.util.List<org.json.JSONObject> messages = chatStore.list(peer);
        chatEmpty.setVisibility(messages.isEmpty() ? View.VISIBLE : View.GONE);
        for (org.json.JSONObject message : messages) chatList.addView(chatBubble(message));
        if (!messages.isEmpty() && chatScroll != null) chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
        // 进入聊天页 = 已读：推进本地位点，并回执给对端。
        long newest = chatStore.lastTs(peer);
        if (newest > readPref(peer)) {
            setReadPref(peer, newest);
            if (client != null && client.isConnected()) client.sendChatRead(newest);
        }
    }

    private void updateChatHeader() {
        if (chatPeerName == null) return;
        String host = ipInput == null ? "" : ipInput.getText().toString().trim();
        if (host.isEmpty()) host = getPreferences(MODE_PRIVATE).getString("last_host", "");
        String peerName = host.isEmpty() ? "" : getPreferences(MODE_PRIVATE).getString("paired_host_name:" + host, "");
        chatPeerName.setText(peerName.isEmpty() ? (english ? "Paired computer" : "已配对的电脑") : peerName);
        boolean online = client != null && client.isConnected();
        if (chatConnectionLabel != null) chatConnectionLabel.setText(online
                ? (english ? "Online · direct local connection" : "在线 · 局域网直连")
                : (english ? "Offline · local chat history" : "离线 · 可查看本地聊天记录"));
        if (chatOnlineDot != null) {
            int dotColor = online ? Color.rgb(0, 220, 130) : Color.rgb(115, 125, 119);
            chatOnlineDot.setBackground(box(dotColor, dotColor, dp(6)));
        }
    }

    /** 构造一条消息气泡（自己发的靠右、绿色；对方发的靠左、深色）。 */
    private View chatBubble(org.json.JSONObject message) {
        boolean out = "out".equals(message.optString("dir", ""));
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity((out ? Gravity.END : Gravity.START) | Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2); rowParams.setMargins(0, dp(4), 0, dp(4)); row.setLayoutParams(rowParams);

        String kind = message.optString("kind", "text");
        LinearLayout bubble = new LinearLayout(this); bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(12), dp(9), dp(12), dp(9));
        bubble.setBackground(solidBox(out ? Color.rgb(18, 61, 43) : Color.rgb(32, 38, 34), dp(16)));
        int maxWidth = Math.round(getResources().getDisplayMetrics().widthPixels * 0.72f);

        if ("file".equals(kind)) {
            String fileName = message.optString("fileName", "文件");
            long fileSize = message.optLong("fileSize", 0);
            String localUri = message.optString("localUri", "");
            Uri attachmentUri = localUri.isEmpty() ? null : Uri.parse(localUri);
            String glyph = fileTypeGlyph(fileName);
            if ("IMG".equals(glyph) && attachmentUri != null) {
                FrameLayout previewFrame = new FrameLayout(this);
                ImageView preview = new ImageView(this); preview.setTag(attachmentUri); preview.setScaleType(ImageView.ScaleType.CENTER_CROP); preview.setBackground(solidBox(Color.rgb(24, 30, 27), dp(10)));
                previewFrame.addView(preview, new FrameLayout.LayoutParams(dp(176), dp(132)));
                TextView fallback = text("IMG", 12, Color.rgb(0, 232, 135)); fallback.setGravity(Gravity.CENTER); previewFrame.addView(fallback, new FrameLayout.LayoutParams(dp(176), dp(132)));
                LinearLayout.LayoutParams previewParams = new LinearLayout.LayoutParams(dp(176), dp(132)); previewParams.bottomMargin = dp(7); bubble.addView(previewFrame, previewParams);
                loadThumbnail(attachmentUri, preview, fallback, fileName); previewFrame.setOnClickListener(v -> openChatAttachment(message));
            }
            TextView name = text(fileName, 14, Color.WHITE); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); name.setMaxWidth(maxWidth); bubble.addView(name);
            TextView meta = text(glyphLabel(glyph) + "  ·  " + android.text.format.Formatter.formatShortFileSize(this, fileSize), 12, Color.rgb(163, 167, 164)); bubble.addView(meta);
            boolean done = message.optBoolean("done", false);
            boolean failed = message.optBoolean("failed", false);
            int progress = message.optInt("progress", 0);
            TextView progressText = text(failed ? (english ? "Transfer failed" : "传输失败") : (done ? (out ? (english ? "Sent" : "已发送") : tr("已接收")) : ((english ? "Progress " : "进度 ") + progress + "%")), 12, failed ? Color.rgb(255, 120, 126) : Color.rgb(0, 232, 135));
            progressText.setPadding(0, dp(4), 0, 0); bubble.addView(progressText);
            ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); bar.setMax(100); bar.setProgress(done ? 100 : progress);
            bar.setProgressTintList(android.content.res.ColorStateList.valueOf(failed ? Color.rgb(235, 82, 91) : Color.rgb(0, 220, 126))); bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(48, 57, 51)));
            LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(-1, dp(3)); barParams.topMargin = dp(5); bubble.addView(bar, barParams);
            String transferId = message.optString("transferId", "");
            if (!transferId.isEmpty()) { chatProgressViews.put(transferId, progressText); chatProgressBars.put(transferId, bar); }
            if (!localUri.isEmpty()) {
                Button open = button(english ? "Open file" : "打开文件"); open.setTextSize(12); open.setMinHeight(dp(34)); open.setPadding(dp(10), 0, dp(10), 0); open.setOnClickListener(v -> openChatAttachment(message));
                LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(-2, dp(34)); openParams.topMargin = dp(6); bubble.addView(open, openParams);
            }
        } else {
            TextView content = text(message.optString("text", ""), 15, Color.WHITE);
            content.setMaxWidth(maxWidth);
            content.setLineSpacing(dp(2), 1f); bubble.addView(content);
        }

        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setGravity(out ? Gravity.RIGHT : Gravity.LEFT);
        body.addView(bubble, new LinearLayout.LayoutParams(-2, -2));
        TextView metaLine = text(chatTimestamp(message.optLong("ts", 0)) + (out ? "  " + tr(statusLabel(message.optString("status", "sent")) + "") : ""), 11, Color.rgb(127, 132, 128));
        metaLine.setPadding(dp(2), dp(3), dp(2), 0); body.addView(metaLine, new LinearLayout.LayoutParams(-2, -2));
        DeviceAvatar avatar = new DeviceAvatar(out);
        LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(28), dp(28));
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-2, -2);
        if (out) { bodyParams.rightMargin = dp(7); row.addView(body, bodyParams); row.addView(avatar, avatarParams); }
        else { avatarParams.rightMargin = dp(7); row.addView(avatar, avatarParams); row.addView(body, bodyParams); }
        return row;
    }

    /** 纯矢量默认头像：本机 Android 显示手机，对端按设备类型显示桌面电脑。 */
    private final class DeviceAvatar extends View {
        private final boolean mobile;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        DeviceAvatar(boolean mobile) { super(MainActivity.this); this.mobile = mobile; setContentDescription(mobile ? (english ? "Phone" : "手机") : (english ? "Computer" : "电脑")); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float s = Math.min(getWidth(), getHeight()), cx = getWidth() / 2f, cy = getHeight() / 2f;
            paint.setStyle(Paint.Style.FILL); paint.setColor(mobile ? Color.rgb(18, 55, 38) : Color.rgb(32, 42, 36)); canvas.drawCircle(cx, cy, s * .49f, paint);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND); paint.setStrokeWidth(Math.max(dp(1.4f), s * .055f));
            paint.setColor(mobile ? Color.rgb(0, 225, 132) : Color.rgb(155, 181, 164));
            if (mobile) {
                RectF phone = new RectF(cx - s * .22f, cy - s * .35f, cx + s * .22f, cy + s * .35f); canvas.drawRoundRect(phone, s * .07f, s * .07f, paint);
                canvas.drawLine(cx - s * .07f, cy + s * .23f, cx + s * .07f, cy + s * .23f, paint);
            } else {
                RectF screen = new RectF(cx - s * .34f, cy - s * .25f, cx + s * .34f, cy + s * .20f); canvas.drawRoundRect(screen, s * .055f, s * .055f, paint);
                canvas.drawLine(cx, cy + s * .20f, cx, cy + s * .33f, paint); canvas.drawLine(cx - s * .19f, cy + s * .34f, cx + s * .19f, cy + s * .34f, paint);
            }
        }
    }

    private GradientDrawable solidBox(int fill, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(fill); d.setCornerRadius(radius); return d; }

    private String statusLabel(String status) {
        if (ChatStore.STATUS_READ.equals(status)) return "已读";
        if (ChatStore.STATUS_DELIVERED.equals(status)) return "已送达";
        return "已发送";
    }

    private String chatTimestamp(long ts) {
        if (ts <= 0) return "";
        return new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(new java.util.Date(ts));
    }

    private void sendChatText() {
        if (chatInput == null) return;
        String content = chatInput.getText().toString();
        if (content.trim().isEmpty()) return;
        if (client == null || !client.isConnected()) { toast("请先连接电脑，再发送消息"); return; }
        String msgId = client.sendChatText(content);
        if (msgId == null) return;
        chatInput.setText("");
        chatStore.append(chatPeerKey(), chatRecord(msgId, "out", "text", content.trim(), System.currentTimeMillis(), ChatStore.STATUS_SENT, "", 0, ""));
        renderChat();
    }

    private void pickChatFile() {
        if (client == null || !client.isConnected()) { toast("请先连接电脑，再发送文件"); return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("*/*"); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        try { startActivityForResult(intent, PICK_CHAT_FILE); } catch (Exception e) { toast("无法打开文件选择器"); }
    }

    private void sendChatFile(Uri uri) {
        if (client == null || !client.isConnected() || uri == null) return;
        String transferId = "t_a_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String msgId = client.sendChatFile(getContentResolver(), uri, transferId);
        if (msgId == null) return;
        String name = displayNameForChat(uri);
        long size = 0;
        try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) size = cursor.getLong(0);
        } catch (Exception ignored) { }
        org.json.JSONObject record = chatRecord(msgId, "out", "file", "", System.currentTimeMillis(), ChatStore.STATUS_SENT, name, size, transferId);
        try { record.put("localUri", uri.toString()).put("mime", getContentResolver().getType(uri)); } catch (Exception ignored) { }
        chatStore.append(chatPeerKey(), record);
        renderChat();
        toast("文件已作为消息发送");
    }

    private String displayNameForChat(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (Exception ignored) { }
        return "文件";
    }

    /** 组装一条本地聊天记录（字段名与协议保持一致）。 */
    private org.json.JSONObject chatRecord(String msgId, String dir, String kind, String text, long ts, String status, String fileName, long fileSize, String transferId) {
        org.json.JSONObject record = new org.json.JSONObject();
        try {
            record.put("msgId", msgId).put("dir", dir).put("kind", kind).put("text", text).put("ts", ts).put("status", status);
            if (!fileName.isEmpty()) record.put("fileName", fileName);
            if (fileSize > 0) record.put("fileSize", fileSize);
            if (!fileName.isEmpty()) record.put("done", false).put("progress", 0);
            if (transferId != null && !transferId.isEmpty()) record.put("transferId", transferId);
        } catch (Exception ignored) { }
        return record;
    }

    private void connect() {
        String ip = ipInput.getText().toString().trim(), code = codeInput.getText().toString().trim();
        String savedToken = getPreferences(MODE_PRIVATE).getString("paired_host:" + ip, "");
        if (ip.isEmpty() || (code.length() != 6 && savedToken.isEmpty())) { toast("请输入电脑 IP 和 6 位匹配码，或选择已配对设备"); return; }
        connectButton.setEnabled(false); status.setText(tr("正在连接…"));
        getPreferences(MODE_PRIVATE).edit().putString("last_host", ip).apply();
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
            ipInput.setText(ip); getPreferences(MODE_PRIVATE).edit().putString("last_host", ip).apply();
            client = createClient(); client.connectWithQr(ip, port, token); return true;
        } catch (Exception ignored) { return false; }
    }

    private void pickFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_FILES); } catch (Exception e) { toast("无法打开文件选择器，请检查系统文件应用"); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_CHAT_FILE) {
            if (result == RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData();
                try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
                sendChatFile(uri);
            }
            return;
        }
        if (request != PICK_FILES || result != RESULT_OK || data == null) return;
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

    private String glyphLabel(String glyph) {
        if ("IMG".equals(glyph)) return english ? "Image" : "图片";
        if ("VID".equals(glyph)) return english ? "Video" : "视频";
        if ("DOC".equals(glyph)) return english ? "Document" : "文档";
        if ("ZIP".equals(glyph)) return english ? "Archive" : "压缩包";
        return english ? "File" : "文件";
    }

    private void openChatAttachment(org.json.JSONObject message) {
        String raw = message.optString("localUri", "");
        if (raw.isEmpty()) { toast(english ? "This file is not available on this device" : "此文件尚未保存在本设备"); return; }
        try {
            Uri uri = Uri.parse(raw); String mime = message.optString("mime", "");
            if (mime.isEmpty()) mime = getContentResolver().getType(uri);
            if (mime == null || mime.isEmpty()) mime = "*/*";
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(intent, english ? "Open with" : "打开文件"));
        } catch (Exception e) { toast(english ? "No app can open this file" : "没有可打开此文件的应用"); }
    }

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
            Button connectSaved = button(english ? "Connect" : "连接"); connectSaved.setTextSize(12); connectSaved.setOnClickListener(v -> { ipInput.setText(host); getPreferences(MODE_PRIVATE).edit().putString("last_host", host).apply(); client = createClient(); connectButton.setEnabled(false); status.setText(tr("正在连接…")); client.connectPaired(host, NativeClient.PORT, token); }); row.addView(connectSaved, new LinearLayout.LayoutParams(dp(88), dp(42)));
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
        FrameLayout overlay = new FrameLayout(this); overlay.setPadding(dp(16), dp(16), dp(16), dp(16)); overlay.setBackground(box(Color.rgb(23, 29, 26), Color.rgb(54, 70, 61), dp(20))); overlay.setElevation(dp(16));
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setOrientation(LinearLayout.HORIZONTAL);
        TextView icon = text("↓", 22, Color.rgb(6, 35, 23)); icon.setGravity(Gravity.CENTER); icon.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); icon.setBackground(box(Color.rgb(0, 210, 131), Color.rgb(0, 210, 131), dp(14))); header.addView(icon, new LinearLayout.LayoutParams(dp(42), dp(42)));
        LinearLayout heading = new LinearLayout(this); heading.setOrientation(LinearLayout.VERTICAL); heading.setPadding(dp(12), 0, 0, 0);
        TextView title = text(english ? "Incoming files" : "收到文件", 17, Color.WHITE); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.addView(title);
        TextView hint = text(english ? "Review details before accepting" : "请确认来源与文件信息", 12, Color.rgb(144, 155, 148)); LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2); hintParams.topMargin = dp(3); heading.addView(hint, hintParams);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1)); body.addView(header);

        LinearLayout network = new LinearLayout(this); network.setOrientation(LinearLayout.VERTICAL); network.setPadding(dp(12), dp(10), dp(12), dp(10)); network.setBackground(box(Color.rgb(18, 24, 21), Color.rgb(42, 51, 46), dp(12))); LinearLayout.LayoutParams networkParams = new LinearLayout.LayoutParams(-1, -2); networkParams.topMargin = dp(14); body.addView(network, networkParams);
        TextView sourceLabel = text(english ? "SENDING DEVICE" : "发送设备", 10, Color.rgb(122, 140, 129)); network.addView(sourceLabel);
        incomingDeviceText = text("—", 14, Color.WHITE); incomingDeviceText.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); LinearLayout.LayoutParams deviceParams = new LinearLayout.LayoutParams(-1, -2); deviceParams.topMargin = dp(3); network.addView(incomingDeviceText, deviceParams);
        incomingIpText = text("IP · —", 12, Color.rgb(155, 169, 160)); LinearLayout.LayoutParams ipParams = new LinearLayout.LayoutParams(-1, -2); ipParams.topMargin = dp(4); network.addView(incomingIpText, ipParams);

        TextView filesLabel = text(english ? "FILES & TRANSFER DETAILS" : "文件与传输详情", 10, Color.rgb(122, 140, 129)); LinearLayout.LayoutParams filesLabelParams = new LinearLayout.LayoutParams(-1, -2); filesLabelParams.topMargin = dp(14); filesLabelParams.bottomMargin = dp(6); body.addView(filesLabel, filesLabelParams);
        incomingOverlayText = text(english ? "Review the incoming file list" : "待接收文件详情", 12, Color.rgb(191, 199, 194)); incomingOverlayText.setLineSpacing(dp(3), 1f); ScrollView details = new ScrollView(this); details.setFillViewport(false); details.setVerticalScrollBarEnabled(true); details.setPadding(dp(12), dp(10), dp(12), dp(10)); details.setBackground(box(Color.rgb(18, 24, 21), Color.rgb(42, 51, 46), dp(12))); details.addView(incomingOverlayText, new ScrollView.LayoutParams(-1, -2)); body.addView(details, new LinearLayout.LayoutParams(-1, dp(92)));
        LinearLayout actions = new LinearLayout(this); actions.setOrientation(LinearLayout.HORIZONTAL); actions.setGravity(Gravity.CENTER_VERTICAL);
        Button reject = button(english ? "Decline" : "拒绝接收"); reject.setTextColor(Color.rgb(202, 211, 205)); reject.setBackground(box(Color.rgb(28, 34, 30), Color.rgb(53, 63, 56), dp(12))); reject.setOnClickListener(v -> { if (client != null) client.rejectIncomingOffer(); hideIncomingOverlay(); receiveActions.setVisibility(View.GONE); });
        Button accept = button(english ? "Accept files" : "接收文件"); accept.setOnClickListener(v -> { if (client != null) { client.acceptIncomingOffer(); client.setChatSilentAccept(true); } hideIncomingOverlay(); receiveActions.setVisibility(View.GONE); });
        LinearLayout.LayoutParams rejectParams = new LinearLayout.LayoutParams(0, dp(48), 1); rejectParams.rightMargin = dp(9); LinearLayout.LayoutParams acceptParams = new LinearLayout.LayoutParams(0, dp(48), 1); actions.addView(reject, rejectParams); actions.addView(accept, acceptParams); LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(-1, dp(52)); actionsParams.topMargin = dp(10); body.addView(actions, actionsParams);
        overlay.addView(body, new FrameLayout.LayoutParams(-1, -2)); return overlay;
    }

    private void showIncomingOverlay(String label, String deviceName, String ip) {
        if (incomingDeviceText != null) incomingDeviceText.setText(deviceName == null || deviceName.isEmpty() ? (english ? "Unknown device" : "未知设备") : deviceName);
        if (incomingIpText != null) incomingIpText.setText("IP · " + (ip == null || ip.isEmpty() ? "—" : ip) + "   ·   " + (english ? "Port " : "端口 ") + NativeClient.PORT);
        if (incomingOverlayText != null) incomingOverlayText.setText(label == null || label.isEmpty() ? (english ? "Incoming files" : "待接收文件") : label);
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
            case "聊天": return "Chat";
            case "输入消息…": return "Type a message…";
            case "与电脑的对话仅在本机局域网内传输，不经过任何服务器。": return "This conversation travels only on your local network — no servers involved.";
            case "还没有消息。在下面输入，或点「+」把文件当消息发过去。": return "No messages yet. Type below, or tap + to send a file as a message.";
            case "已发送": return "Sent";
            case "已送达": return "Delivered";
            case "已读": return "Read";
            case "已接收": return "Received";
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

    @Override public void onConnected(String name) { runOnUiThread(() -> { status.setText((english ? "Connected · " : "已连接 · ") + name); connectButton.setEnabled(true); connectButton.setText(tr("已连接")); pickButton.setText(tr("选择文件")); updateSendButtonState(); updateChatHeader(); }); }
    @Override public void onConnectionDetails(String name, String serverId, String token, String host) { SharedPreferences prefs = getPreferences(MODE_PRIVATE); SharedPreferences.Editor editor = prefs.edit(); if (host != null && !host.isEmpty()) { if (token != null && !token.isEmpty()) editor.putString("paired_host:" + host, token); if (serverId != null && !serverId.isEmpty()) { editor.putString("paired_host_device:" + host, serverId); if (token != null && !token.isEmpty()) editor.putString("paired_device:" + serverId, token); } editor.putString("paired_host_name:" + host, name); } editor.putString("last_connect_name", name); editor.apply(); runOnUiThread(this::renderPairedDevices); }
    @Override public void onError(String message) { runOnUiThread(() -> { if (message != null && (message.contains("匹配凭证已失效") || message.contains("Pairing token expired"))) { String ip = ipInput.getText().toString().trim(); SharedPreferences.Editor editor = getPreferences(MODE_PRIVATE).edit().remove("paired_host:" + ip); String serverId = getPreferences(MODE_PRIVATE).getString("paired_host_device:" + ip, ""); if (!serverId.isEmpty()) editor.remove("paired_device:" + serverId).remove("paired_host_device:" + ip); editor.apply(); codeInput.requestFocus(); } status.setText(tr("连接失败")); connectButton.setEnabled(true); updateSendButtonState(); updateChatHeader(); toast(message); }); }
    @Override public void onRejected(String reason) { runOnUiThread(() -> { status.setText(english ? "Transfer rejected by the computer" : "电脑已拒绝接收"); toast(english ? "The recipient declined this transfer" : "对方拒绝了本次文件传输"); }); }
    @Override public void onSendWaiting(List<Uri> files) { runOnUiThread(() -> { sendInProgress = true; status.setText(english ? "Waiting for recipient approval" : "等待电脑确认接收"); updateSendButtonState(); }); }
    @Override public void onSendAccepted(List<Uri> files) { runOnUiThread(() -> { pendingUris.removeAll(files); updatePendingText(); status.setText(english ? "Sending files…" : "正在发送文件…"); }); }
    @Override public void onSendFailed(List<Uri> files, String error) { runOnUiThread(() -> { for (Uri uri : files) if (!pendingUris.contains(uri)) pendingUris.add(uri); sendInProgress = false; updatePendingText(); updateSendButtonState(); }); }
    @Override public void onSendRejected(List<Uri> files) { runOnUiThread(() -> { sendInProgress = false; updatePendingText(); updateSendButtonState(); }); }
    @Override public void onTransferFinished(boolean incoming, String label, boolean success) {
        if (!incoming) runOnUiThread(() -> { sendInProgress = false; updateSendButtonState(); });
        else runOnUiThread(this::renderChat);
        recordTransfer(incoming, label, success);
    }    @Override public void onClosed() { runOnUiThread(() -> { status.setText(tr("连接已断开")); connectButton.setEnabled(true); pickButton.setText(tr("选择文件")); updateSendButtonState(); updateChatHeader(); }); }
    @Override public void onIncomingOffer(String label, String deviceName, String ip) { runOnUiThread(() -> { status.setText(english ? "Waiting for confirmation" : "等待接收确认"); receiveText.setText(english ? "From: " + deviceName + " · " + ip + "\nFiles: " + label : "来源：" + deviceName + " · " + ip + "\n文件：" + label); showIncomingOverlay(label, deviceName, ip); toast(english ? "Incoming files · review and accept or decline" : "收到文件，请确认接收或拒绝"); showIncomingNotification(label, deviceName, ip); }); }

    private void createNotificationChannel() { if (Build.VERSION.SDK_INT >= 26) { NotificationChannel c = new NotificationChannel("transfer", english ? "File transfers" : "文件传输", NotificationManager.IMPORTANCE_DEFAULT); getSystemService(NotificationManager.class).createNotificationChannel(c); } }
    private void showIncomingNotification(String label, String deviceName, String ip) { if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return; int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0); Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); PendingIntent openAction = PendingIntent.getActivity(this, 77, open, flags); Intent accept = new Intent(this, MainActivity.class).setAction("com.lantransfer.mobile.ACCEPT_INCOMING").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); Intent reject = new Intent(this, MainActivity.class).setAction("com.lantransfer.mobile.REJECT_INCOMING").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); PendingIntent acceptAction = PendingIntent.getActivity(this, 78, accept, flags); PendingIntent rejectAction = PendingIntent.getActivity(this, 79, reject, flags); android.app.Notification.Builder notification = new android.app.Notification.Builder(this, "transfer").setSmallIcon(com.lantransfer.mobile.R.mipmap.ic_launcher).setContentTitle(english ? "Incoming files · Nearby Transfer" : "邻传收到文件").setContentText((english ? "From " : "来自 ") + deviceName + " · " + ip + " · " + label).setContentIntent(openAction).setAutoCancel(true).addAction(0, english ? "Decline" : "拒绝", rejectAction).addAction(0, english ? "Accept" : "接收", acceptAction); NotificationManager n = (NotificationManager) getSystemService(NOTIFICATION_SERVICE); n.notify(77, notification.build()); }

    private void showNotificationPermissionDialog() {
        boolean granted = Build.VERSION.SDK_INT < 33 || checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        if (granted) { toast(english ? "Notifications are enabled" : "通知已开启"); return; }
        android.app.Dialog dialog = new android.app.Dialog(this); dialog.getWindow();
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(22), dp(20), dp(22), dp(18)); panel.setBackground(box(Color.rgb(20, 27, 23), Color.rgb(0, 196, 117), dp(22)));
        TextView icon = text("🔔", 25, Color.rgb(0, 232, 135)); icon.setGravity(Gravity.CENTER); panel.addView(icon, params(-1, dp(42)));
        TextView title = text(english ? "Stay on top of incoming files" : "及时看到收到的文件", 19, Color.WHITE); title.setGravity(Gravity.CENTER); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); panel.addView(title, params(-1, dp(34)));
        TextView copy = text(english ? "Allow notifications to see file requests and transfer updates when Nearby Transfer is in the background." : "允许通知后，邻传在后台时也能提醒你确认文件，并告知传输状态。你仍可在应用内查看和处理文件。", 14, Color.rgb(177, 187, 180)); copy.setGravity(Gravity.CENTER); copy.setLineSpacing(dp(3), 1f); LinearLayout.LayoutParams copyParams = params(-1, -2); copyParams.topMargin = dp(6); copyParams.bottomMargin = dp(18); panel.addView(copy, copyParams);
        LinearLayout actions = new LinearLayout(this); actions.setGravity(Gravity.CENTER_VERTICAL); actions.setOrientation(LinearLayout.HORIZONTAL);
        Button later = button(english ? "Not now" : "稍后再说"); later.setTextSize(13); actions.addView(later, new LinearLayout.LayoutParams(0, dp(44), 1));
        Button allow = button(english ? "Continue" : "继续授权"); allow.setTextSize(13); LinearLayout.LayoutParams allowParams = new LinearLayout.LayoutParams(0, dp(44), 1); allowParams.leftMargin = dp(10); actions.addView(allow, allowParams); panel.addView(actions);
        dialog.setContentView(panel); android.view.Window window = dialog.getWindow(); if (window != null) { window.setBackgroundDrawableResource(android.R.color.transparent); window.setLayout((int)(getResources().getDisplayMetrics().widthPixels * .88f), -2); window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND); android.view.WindowManager.LayoutParams lp = window.getAttributes(); lp.dimAmount = .72f; window.setAttributes(lp); }
        later.setOnClickListener(v -> dialog.dismiss()); allow.setOnClickListener(v -> { dialog.dismiss(); if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 77); else { try { startActivity(new Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("android.provider.extra.APP_PACKAGE", getPackageName())); } catch (Exception ignored) { } } }); dialog.show(); if (dialog.getWindow() != null) dialog.getWindow().setLayout((int)(getResources().getDisplayMetrics().widthPixels * .88f), -2);
    }
    @Override public void onProgress(int percent) { onProgress(percent, false); }
    @Override public void onProgress(int percent, boolean receiving) {
        runOnUiThread(() -> {
            status.setText(english ? (receiving ? "Receiving " : "Sending ") + percent + "%" : (receiving ? "正在接收 " : "正在发送 ") + percent + "%");
            // 聊天页的文件气泡就地刷新进度（不重建整棵列表，避免闪烁）。
        });
    }

    @Override public void onChatFileProgress(String transferId, int percent) {
        runOnUiThread(() -> {
            chatStore.updateAttachmentProgress(chatPeerKey(), transferId, percent);
            TextView progress = chatProgressViews.get(transferId);
            if (progress != null) progress.setText((english ? "Progress " : "进度 ") + percent + "%");
            ProgressBar bar = chatProgressBars.get(transferId); if (bar != null) bar.setProgress(percent);
        });
    }

    @Override public void onChatFileFinished(String transferId, boolean incoming, boolean success, Uri uri) {
        runOnUiThread(() -> {
            String mime = "";
            try { if (uri != null) mime = getContentResolver().getType(uri); } catch (Exception ignored) { }
            chatStore.updateAttachmentLocation(chatPeerKey(), transferId, success && uri != null ? uri.toString() : "", mime, success);
            if (!success) chatStore.updateAttachmentFailure(chatPeerKey(), transferId);
            renderChat();
        });
    }

    // ── 聊天回调 ───────────────────────────────────────────────

    @Override public void onChatMessage(String msgId, long ts, String text, String fileName, long fileSize, String transferId) {
        runOnUiThread(() -> {
            String peer = chatPeerKey();
            org.json.JSONObject record = new org.json.JSONObject();
            try {
                boolean isFile = fileName != null && !fileName.isEmpty();
                record.put("msgId", msgId).put("dir", "in").put("kind", isFile ? "file" : "text")
                        .put("text", text == null ? "" : text).put("ts", ts).put("status", ChatStore.STATUS_READ);
                if (isFile) record.put("fileName", fileName).put("fileSize", fileSize).put("done", false).put("progress", 0);
                if (transferId != null && !transferId.isEmpty()) record.put("transferId", transferId);
            } catch (Exception ignored) { }
            chatStore.append(peer, record);
            // 收到对端消息时直接进入聊天页，保持桌面端与手机端行为一致。
            showPage(2);
            toast(english ? "New chat message from the computer" : "收到电脑端的新消息");
        });
    }

    @Override public void onChatAck(String msgId, long ts) {
        runOnUiThread(() -> { chatStore.updateStatus(chatPeerKey(), msgId, ChatStore.STATUS_DELIVERED); renderChat(); });
    }

    @Override public void onChatRead(long upToTs) {
        runOnUiThread(() -> {
            String peer = chatPeerKey();
            for (org.json.JSONObject message : chatStore.list(peer)) {
                if ("out".equals(message.optString("dir", "")) && message.optLong("ts", 0) <= upToTs) {
                    chatStore.updateStatus(peer, message.optString("msgId", ""), ChatStore.STATUS_READ);
                }
            }
            renderChat();
        });
    }

    @Override public void onChatFileAccepted(String transferId) {
        runOnUiThread(() -> { chatStore.updateAttachmentDone(chatPeerKey(), transferId, false); renderChat(); });
    }

    @Override public void onChatFileRejected(String transferId) {
        runOnUiThread(() -> { chatStore.updateAttachmentFailure(chatPeerKey(), transferId); toast(english ? "The computer declined the file" : "电脑端拒绝了该文件"); renderChat(); });
    }

    @Override protected void onDestroy() { if (client != null) client.close(); if (discovery != null) discovery.stop(); thumbnailExecutor.shutdownNow(); super.onDestroy(); }

    private TextView text(String value, int size, int color) { TextView v = new TextView(this); v.setText(tr(value)); v.setTextSize(size); v.setTextColor(color); v.setBackgroundColor(Color.TRANSPARENT); return v; }
    private EditText input(String hint) { EditText v = new EditText(this); v.setHint(tr(hint)); v.setHintTextColor(Color.rgb(127,132,128)); v.setTextColor(Color.WHITE); v.setTextSize(15); v.setSingleLine(true); v.setPadding(dp(16), 0, dp(16), 0); v.setBackground(box(Color.rgb(31,36,33), Color.rgb(42,47,45), dp(12))); return v; }
    private Button button(String label) { Button b = new Button(this); b.setText(tr(label)); b.setTextSize(15); b.setTextColor(Color.rgb(7,26,18)); b.setAllCaps(false); b.setPadding(dp(12), 0, dp(12), 0); b.setBackground(box(Color.rgb(7,193,96), Color.rgb(7,193,96), dp(12))); return b; }
    private GradientDrawable box(int fill, int stroke, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(fill); d.setCornerRadius(radius); d.setStroke(dp(1), stroke); return d; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
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
