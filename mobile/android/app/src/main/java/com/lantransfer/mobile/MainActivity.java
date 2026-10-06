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
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

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
    private TextView pendingText;
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
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(24), dp(24), dp(24), dp(24)); root.setBackgroundColor(Color.rgb(15, 18, 16));
        root.addView(text("邻传", 30, Color.WHITE), params(-1, 48));
        root.addView(text("局域网高速互传", 14, Color.rgb(163, 167, 164)), params(-1, 28));
        status = text("未连接", 14, Color.rgb(0, 232, 135)); status.setGravity(Gravity.CENTER_VERTICAL); root.addView(status, params(-1, 44));
        TextView section = text("连接电脑", 20, Color.WHITE); section.setPadding(0, dp(24), 0, dp(8)); root.addView(section, params(-1, 60));
        ipInput = input("电脑 IP，例如 192.168.1.23"); root.addView(ipInput, params(-1, 52));
        codeInput = input("6 位匹配码"); codeInput.setInputType(InputType.TYPE_CLASS_NUMBER); root.addView(codeInput, params(-1, 52));
        connectButton = button("使用匹配码连接"); connectButton.setOnClickListener(v -> connect()); root.addView(connectButton, params(-1, 52));
        Button scanButton = button("扫描电脑二维码"); scanButton.setTextColor(Color.WHITE); scanButton.setBackground(box(Color.rgb(31,36,33), Color.rgb(7,193,96), dp(12))); scanButton.setOnClickListener(v -> scanQr()); root.addView(scanButton, params(-1, 52));
        pickButton = button("选择文件（加入待发送）"); pickButton.setOnClickListener(v -> pickFiles()); root.addView(pickButton, params(-1, 52));
        pendingText = text("待发送区：暂无文件", 14, Color.rgb(163, 167, 164)); pendingText.setPadding(0, dp(10), 0, dp(4)); root.addView(pendingText, params(-1, 38));
        Button sendButton = button("发送待选文件"); sendButton.setOnClickListener(v -> sendPendingFiles()); root.addView(sendButton, params(-1, 52));
        receiveText = text("接收区：暂无文件", 14, Color.rgb(163, 167, 164)); receiveText.setPadding(0, dp(10), 0, dp(40)); root.addView(receiveText, params(-1, 48));
        receiveActions = new LinearLayout(this); receiveActions.setOrientation(LinearLayout.HORIZONTAL); receiveActions.setGravity(Gravity.CENTER_VERTICAL); receiveActions.setPadding(0, 0, 0, 0); receiveActions.setBackgroundColor(Color.TRANSPARENT); receiveActions.setVisibility(View.GONE);
        Button rejectReceive = button("拒绝接收"); rejectReceive.setTextColor(Color.WHITE); rejectReceive.setBackground(box(Color.rgb(31,36,33), Color.rgb(180,70,80), dp(12))); rejectReceive.setOnClickListener(v -> { if (client != null) client.rejectIncomingOffer(); receiveActions.setVisibility(View.GONE); receiveText.setText("接收区：已拒绝"); });
        Button acceptReceive = button("确认接收"); acceptReceive.setOnClickListener(v -> { if (client != null) client.acceptIncomingOffer(); receiveActions.setVisibility(View.GONE); receiveText.setText("接收区：正在接收"); });
        receiveActions.addView(rejectReceive, new LinearLayout.LayoutParams(0, dp(52), 1)); receiveActions.addView(acceptReceive, new LinearLayout.LayoutParams(0, dp(52), 1)); root.addView(receiveActions, params(-1, 64));
        Button help = button("手机和电脑连接同一 Wi‑Fi，在电脑端配对页获取 IP 与匹配码"); help.setTextColor(Color.rgb(163, 167, 164)); help.setBackgroundColor(Color.TRANSPARENT); root.addView(help, params(-1, 72));
        setContentView(root);
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
        super.onActivityResult(request, result, data); if (request != PICK_FILES || result != RESULT_OK || data == null || client == null) return;
        if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) addPickedUri(data.getClipData().getItemAt(i).getUri()); else if (data.getData() != null) addPickedUri(data.getData());
        updatePendingText();
    }

    private void addPickedUri(Uri uri) { try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {} pendingUris.add(uri); }

    private void sendPendingFiles() {
        if (pendingUris.isEmpty()) { toast("请先选择文件"); return; }
        if (client == null || !client.isConnected()) { toast("请先连接电脑，再发送待选文件"); return; }
        client.sendFiles(getContentResolver(), new ArrayList<>(pendingUris)); pendingUris.clear(); updatePendingText(); toast("已发送文件，等待电脑确认");
    }

    private void updatePendingText() { if (pendingText != null) pendingText.setText(pendingUris.isEmpty() ? "待发送区：暂无文件" : "待发送区：" + pendingUris.size() + " 个文件，点击下方发送"); }

    @Override public void onConnected(String name) { runOnUiThread(() -> { status.setText("已连接 · " + name); connectButton.setText("已连接"); pickButton.setText("选择文件（加入待发送）"); }); }
    @Override public void onError(String message) { runOnUiThread(() -> { status.setText("连接失败"); connectButton.setEnabled(true); toast(message); }); }
    @Override public void onClosed() { runOnUiThread(() -> { status.setText("连接已断开"); connectButton.setEnabled(true); pickButton.setText("选择文件（加入待发送）"); }); }
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
