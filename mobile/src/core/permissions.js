/**
 * 手机端权限策略：只处理实际需要的摄像头权限。
 * 文件选择使用系统 picker，不额外申请存储/照片库权限。
 */

export async function getCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'camera' });
      return status.state || 'prompt';
    }
  } catch (_) { /* 部分 WebView 不支持 camera 权限查询 */ }
  return 'prompt';
}

export async function requestCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前设备不支持摄像头');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stream.getTracks().forEach((track) => track.stop());
  return 'granted';
}

export function isNativeCapacitor() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform?.());
}
