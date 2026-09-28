package com.mitchel.claude_monitor

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AppUpdateBridge(private val activity: FlutterActivity, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "xiaomeng/app_updates")
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val prefs = activity.getSharedPreferences("app_updates", 0)
    private val directory = File(activity.cacheDir, "updates")
    private val apk = File(directory, "update.apk")
    private val partial = File(directory, "update.part")
    private val client = OkHttpClient.Builder()
        .connectTimeout(25, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.MINUTES)
        .followSslRedirects(false)
        .addNetworkInterceptor { chain ->
            val url = chain.request().url
            check(url.isHttps && url.host in setOf(
                "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
            )) { "更新下载地址不可信" }
            chain.proceed(chain.request())
        }.build()
    @Volatile private var call: Call? = null
    @Volatile private var cancelled = false
    @Volatile private var disposed = false
    private var downloading = false

    init {
        channel.setMethodCallHandler { request, result ->
            when (request.method) {
                "info" -> runCatching { info() }
                    .onSuccess { result.success(it) }
                    .onFailure { result.error("info", "无法读取应用版本", null) }
                "download" -> {
                    if (downloading) {
                        result.error("busy", "更新正在下载中", null)
                    } else {
                        downloading = true
                        cancelled = false
                        val metadata = JSONObject(request.arguments as Map<*, *>)
                        worker.execute {
                            try {
                                download(metadata)
                                reply {
                                    downloading = false
                                    result.success(true)
                                }
                            } catch (error: Exception) {
                                partial.delete()
                                reply {
                                    downloading = false
                                    result.error("download", if (cancelled) "下载已取消" else error.message ?: "下载失败", null)
                                }
                            } finally {
                                call = null
                            }
                        }
                    }
                }
                "cancel" -> {
                    cancelled = true
                    call?.cancel()
                    result.success(null)
                }
                "clear" -> {
                    if (downloading) {
                        result.error("busy", "请先取消下载", null)
                    } else {
                        clear()
                        result.success(null)
                    }
                }
                "install" -> worker.execute {
                    try {
                        val metadata = JSONObject(prefs.getString("ready", null) ?: error("更新文件已失效，请重新下载"))
                        verify(apk, metadata)
                        reply {
                            try {
                                if (!canInstall()) {
                                    activity.startActivity(Intent(
                                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                        Uri.parse("package:${activity.packageName}"),
                                    ))
                                    result.success(false)
                                } else {
                                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
                                    activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                                        setDataAndType(uri, "application/vnd.android.package-archive")
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    })
                                    result.success(true)
                                }
                            } catch (_: Exception) {
                                result.error("install", "无法打开系统安装界面，请检查设备设置", null)
                            }
                        }
                    } catch (error: Exception) {
                        clear()
                        reply { result.error("install", error.message, null) }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun packageFlags() = if (Build.VERSION.SDK_INT >= 28) {
        PackageManager.GET_SIGNING_CERTIFICATES
    } else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun current() = activity.packageManager.getPackageInfo(activity.packageName, packageFlags())

    @Suppress("DEPRECATION")
    private fun build(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun certificates(info: PackageInfo): List<ByteArray> =
        (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures)
            ?.map { it.toByteArray() } ?: emptyList()

    private fun digest(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun canInstall() = Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()

    private fun info(): Map<String, Any?> {
        val current = current()
        val saved = prefs.getString("ready", null)
        if (saved != null && (!apk.exists() || runCatching {
                JSONObject(saved).getLong("build") <= build(current)
            }.getOrDefault(true))) clear()
        val debug = certificates(current).any {
            val certificate = CertificateFactory.getInstance("X.509")
                .generateCertificate(it.inputStream()) as X509Certificate
            certificate.subjectX500Principal.name.contains("CN=Android Debug")
        }
        return mapOf(
            "version" to current.versionName,
            "build" to build(current),
            "debugSigned" to debug,
            "canInstall" to canInstall(),
            "ready" to prefs.getString("ready", null),
        )
    }

    private fun hasWifi(): Boolean {
        val manager = activity.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun download(metadata: JSONObject) {
        val url = Uri.parse(metadata.getString("url"))
        require(url.scheme == "https" && url.host == "github.com" &&
            url.userInfo == null && (url.port == -1 || url.port == 443) &&
            url.path?.startsWith("/xh20220630/xiaomeng-hub/releases/download/") == true
        ) { "更新下载地址不可信" }
        val expected = metadata.getLong("bytes")
        require(expected in 1..(512L * 1024 * 1024)) { "安装包大小无效" }
        val wifiOnly = metadata.optBoolean("wifiOnly")
        if (wifiOnly && !hasWifi()) error("等待非计费 Wi-Fi 网络自动下载，也可手动下载")
        directory.mkdirs()
        clear()
        val request = client.newCall(Request.Builder().url(url.toString()).build())
        call = request
        if (cancelled) error("下载已取消")
        request.execute().use { response ->
            check(response.isSuccessful) { "下载失败（HTTP ${response.code}），请稍后重试" }
            val body = response.body ?: error("服务器返回了空文件")
            check(body.contentLength() == -1L || body.contentLength() == expected) { "安装包大小与发布信息不符" }
            body.byteStream().use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var received = 0L
                    var lastProgress = 0L
                    while (true) {
                        if (cancelled) error("下载已取消")
                        val count = input.read(buffer)
                        if (count == -1) break
                        received += count
                        check(received <= expected) { "安装包超出预期大小" }
                        output.write(buffer, 0, count)
                        val now = android.os.SystemClock.elapsedRealtime()
                        if (now - lastProgress >= 500) {
                            if (wifiOnly && !hasWifi()) error("Wi-Fi 已断开，下载已停止；回到应用后可重试")
                            lastProgress = now
                            reply { channel.invokeMethod("progress", received.toDouble() / expected) }
                        }
                    }
                }
            }
        }
        verify(partial, metadata)
        if (cancelled) error("下载已取消")
        check(partial.renameTo(apk)) { "无法保存安装包，请检查存储空间" }
        metadata.remove("wifiOnly")
        check(prefs.edit().putString("ready", metadata.toString()).commit()) { "无法保存更新状态" }
        reply { channel.invokeMethod("progress", 1.0) }
    }

    @Suppress("DEPRECATION")
    private fun verify(file: File, metadata: JSONObject) {
        check(file.exists() && file.length() == metadata.getLong("bytes")) { "安装包不完整，请重新下载" }
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                hash.update(buffer, 0, count)
            }
        }
        check(hash.digest().joinToString("") { "%02x".format(it) }.equals(metadata.getString("sha256"), true)) {
            "安装包 SHA-256 校验失败，请重新下载"
        }
        val candidate = activity.packageManager.getPackageArchiveInfo(file.path, packageFlags())
            ?: error("无法解析安装包")
        val installed = current()
        check(candidate.packageName == activity.packageName) { "安装包不属于小梦应用" }
        check(build(candidate) == metadata.getLong("build") && build(candidate) > build(installed) &&
            candidate.versionName == metadata.getString("version")) { "安装包版本不匹配或版本过旧" }
        check((candidate.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) <= Build.VERSION.SDK_INT) {
            "此版本需要更高版本的 Android"
        }
        // A debug-signed preview cannot overwrite a production-signed installation (or vice versa).
        val signatures = certificates(candidate).map(::digest).toSet()
        check(signatures.isNotEmpty() && signatures == certificates(installed).map(::digest).toSet()) {
            "新版签名与当前应用不一致，无法覆盖安装；请使用相同签名渠道的安装包"
        }
    }

    private fun clear() {
        prefs.edit().remove("ready").apply()
        apk.delete()
        partial.delete()
    }

    private fun reply(action: () -> Unit) {
        handler.post { if (!disposed) action() }
    }

    fun dispose() {
        disposed = true
        cancelled = true
        call?.cancel()
        channel.setMethodCallHandler(null)
        worker.shutdown()
    }
}
