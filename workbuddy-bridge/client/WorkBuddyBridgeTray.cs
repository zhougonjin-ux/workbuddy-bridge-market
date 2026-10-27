// WorkBuddy 积分桥 · 桌面客户端（0.3.50）
//
// 双击 = 打开原生桌面控制台（wb-switch 同款设计语言：左侧窄边栏导航 +
// 内容区浅灰底现代卡片）。四个页面：账号管理 / 任务中心 / 用量 / 设置。
// 关闭（X）= 隐藏到托盘；托盘双击/菜单 = 显示窗口。
// 服务自启保证：启动时健康检查不过就拉起服务（bridge-path.txt / 便携同级定位）。
//
// 系统自带 .NET Framework csc 编译（build.cmd），零第三方依赖。
// 语言版本锁定 C# 5：禁字符串插值 / ?. / out 内联声明；异步用「线程 + BeginInvoke」；
// JSON 用 System.Web.Extensions 的 JavaScriptSerializer；跨类调用 Program 的 public static。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Linq;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    public const string AppName = "WorkBuddy 积分桥";
    public static NotifyIcon tray;
    public static MainForm mainForm;
    public static int port = 8788;
    public static string apiKey = "";
    public static string serverDir;
    public static string pluginVersion = "";

    public static string Port { get { return port.ToString(); } }

    [STAThread]
    static void Main(string[] args)
    {
        bool noOpen = Array.IndexOf(args, "--no-open") >= 0;
        bool createdNew;
        using (Mutex mutex = new Mutex(true, "WorkBuddyBridgeTray", out createdNew))
        {
            if (!createdNew) { ShowMain(); return; }
            serverDir = ResolveServerDir();
            LoadConfig(); // 必须在 ResolveServerDir 之后：pluginVersion 从 serverDir/package.json 读
            if (serverDir == null)
            {
                MessageBox.Show("没有找到服务目录（server\\server.mjs）。\n\n请运行 WorkBuddyBridgeSetup.exe 完成安装，\n或在弹出窗口中选择 server 目录。",
                    AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                using (var dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选择插件里的 server 目录（含 server.mjs）";
                    if (dlg.ShowDialog() == DialogResult.OK && File.Exists(Path.Combine(dlg.SelectedPath, "server.mjs")))
                    {
                        serverDir = dlg.SelectedPath;
                        try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge-path.txt"), serverDir); } catch { }
                    }
                    else return;
                }
            }
            EnsureService();
            Application.EnableVisualStyles();
            tray = new NotifyIcon();
            tray.Icon = MakeIcon(true);
            tray.Text = AppName;
            tray.Visible = true;
            BuildTrayMenu();
            mainForm = new MainForm();
            if (!noOpen) mainForm.Show();
            Application.Run();
            GC.KeepAlive(mutex);
        }
    }

    public static void ShowMain()
    {
        if (mainForm == null || mainForm.IsDisposed) { mainForm = new MainForm(); mainForm.Show(); }
        else { mainForm.Show(); mainForm.WindowState = FormWindowState.Normal; mainForm.Activate(); }
    }

    public static void BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("显示窗口");
        open.Font = new Font(open.Font, FontStyle.Bold);
        open.Click += delegate { ShowMain(); };
        var web = new ToolStripMenuItem("网页控制台");
        web.Click += delegate { OpenConsole(); };

        var copyBase = new ToolStripMenuItem("复制 Base URL");
        copyBase.Click += delegate { CopyText("Base URL", "http://127.0.0.1:" + port + "/v1"); };
        var copyKey = new ToolStripMenuItem("复制 API Key");
        copyKey.Click += delegate { CopyText("API Key", apiKey); };
        var dataDir = new ToolStripMenuItem("打开数据目录");
        dataDir.Click += delegate { OpenPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".zcode", "workbuddy-bridge")); };
        var logFile = new ToolStripMenuItem("查看服务日志");
        logFile.Click += delegate { OpenPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".zcode", "workbuddy-bridge", "server.log")); };

        var start = new ToolStripMenuItem("启动服务");
        start.Click += delegate { new Thread(delegate() { Program.RunBlocking(delegate { if (!Program.Health()) Program.StartService(); }); }).Start(); };
        var stop = new ToolStripMenuItem("停止服务");
        stop.Click += delegate { new Thread(delegate() { Program.RunBlocking(delegate { if (Program.Health()) Program.StopService(); }); }).Start(); };
        var restart = new ToolStripMenuItem("重启服务");
        restart.Click += delegate { new Thread(delegate() { Program.RunBlocking(Program.RestartService); }).Start(); };

        var update = new ToolStripMenuItem("检查插件更新…");
        update.Click += delegate { CheckUpdateUi(); };
        var autoRun = new ToolStripMenuItem("开机自启");
        autoRun.CheckOnClick = true;
        autoRun.Checked = IsAutoRun();
        autoRun.Click += delegate { SetAutoRun(autoRun.Checked); };
        var installPlugin = new ToolStripMenuItem("给智能体安装插件…");
        installPlugin.Click += delegate { InstallPluginToZcode(); };

        var quit = new ToolStripMenuItem("退出");
        quit.Click += delegate
        {
            if (Health() && MessageBox.Show(
                "退出前要一并停止本地代理服务吗？\n（停止后智能体会话暂时无法调用模型）",
                AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                StopService();
            if (tray != null) tray.Visible = false;
            Application.Exit();
        };

        menu.Items.AddRange(new ToolStripItem[] {
            open, web, new ToolStripSeparator(),
            copyBase, copyKey, dataDir, logFile, new ToolStripSeparator(),
            start, stop, restart, new ToolStripSeparator(),
            update, autoRun, installPlugin, new ToolStripSeparator(), quit,
        });
        if (tray != null)
        {
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { ShowMain(); };
        }
    }

    /** 托盘菜单动作：复制到剪贴板并提示（菜单事件在 UI 线程，Clipboard 可用）。 */
    static void CopyText(string label, string text)
    {
        try
        {
            Clipboard.SetText(text ?? "");
            MessageBox.Show(label + " 已复制到剪贴板", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("复制失败：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /** 打开文件或目录；不存在时给出可读提示，而不是抛系统异常。 */
    static void OpenPath(string path)
    {
        try
        {
            if (!File.Exists(path) && !Directory.Exists(path))
            {
                MessageBox.Show("路径不存在：\n" + path, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Process.Start(path);
        }
        catch (Exception ex)
        {
            MessageBox.Show("打开失败：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    const string RegRun = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const string RegRunName = "WorkBuddyBridgeTray";

    static bool IsAutoRun()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegRun, false))
                return k != null && k.GetValue(RegRunName) != null;
        }
        catch { return false; }
    }

    static void SetAutoRun(bool on)
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RegRun))
            {
                if (on) k.SetValue(RegRunName, "\"" + Application.ExecutablePath + "\"");
                else k.DeleteValue(RegRunName, false);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("设置开机自启失败：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /** 检查插件更新：走服务端 /console/api/update-check（多源并发 + 缓存）。 */
    public static void CheckUpdateUi()
    {
        if (!Health())
        {
            MessageBox.Show("服务未运行，无法检查更新。先「启动服务」再试。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        try
        {
            string json = Api("GET", "/console/api/update-check", null);
            var ser = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var d = ser.DeserializeObject(json) as Dictionary<string, object>;
            string local = d != null && d.ContainsKey("local") ? Convert.ToString(d["local"]) : "?";
            string latest = d != null && d.ContainsKey("latest") ? Convert.ToString(d["latest"]) : "";
            bool has = d != null && d.ContainsKey("updateAvailable") && d["updateAvailable"] is bool && (bool)d["updateAvailable"];
            string note = d != null && d.ContainsKey("note") ? Convert.ToString(d["note"]) : "";
            string msg;
            if (has)
                msg = "发现新版本：v" + latest + "（当前 v" + local + "）\n\n更新方式：插件市场 → 刷新市场 → 插件详情 → 更新。";
            else if (string.IsNullOrEmpty(latest))
                msg = "暂时检查不了（" + (string.IsNullOrEmpty(note) ? "网络或上游不可达" : note) + "）。\n当前 v" + local + "。";
            else
                msg = "已是最新：v" + local + "。";
            MessageBox.Show(msg, AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("检查更新失败：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void LoadConfig()
    {
        port = 8788; apiKey = ""; pluginVersion = "";
        try
        {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".zcode", "workbuddy-bridge", "config.json");
            if (File.Exists(path))
            {
                string json = File.ReadAllText(path);
                port = ReadInt(json, "port", 8788);
                apiKey = ReadString(json, "apiKey");
            }
            if (serverDir != null && File.Exists(Path.Combine(serverDir, "package.json")))
            {
                var mv = System.Text.RegularExpressions.Regex.Match(
                    File.ReadAllText(Path.Combine(serverDir, "package.json")), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                if (mv.Success) pluginVersion = mv.Groups[1].Value;
            }
        }
        catch { }
    }

    static int ReadInt(string json, string key, int fallback)
    {
        var m = System.Text.RegularExpressions.Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?\\d+)");
        return m.Success ? int.Parse(m.Groups[1].Value) : fallback;
    }

    static string ReadString(string json, string key)
    {
        var m = System.Text.RegularExpressions.Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : "";
    }

    static string ResolveServerDir()
    {
        string portable = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "server"));
        try { if (File.Exists(Path.Combine(portable, "server.mjs"))) return portable; } catch { }
        try
        {
            string marker = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge-path.txt");
            if (File.Exists(marker))
            {
                string dir = File.ReadAllText(marker).Trim();
                if (File.Exists(Path.Combine(dir, "server.mjs"))) return dir;
            }
        }
        catch { }
        return null;
    }

    public static bool Health()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/health");
            req.Method = "GET"; req.Timeout = 2000; req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse()) return (int)resp.StatusCode == 200;
        }
        catch { return false; }
    }

    public static string Api(string method, string path, string body)
    {
        var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
        req.Method = method; req.Timeout = 120000; req.Proxy = null;
        req.Headers.Add("Authorization", "Bearer " + apiKey);
        req.ContentType = "application/json";
        if (body != null)
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            req.ContentLength = bytes.Length;
            using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
        }
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return sr.ReadToEnd();
    }

    public static void OpenConsole(string view = null)
    {
        // view 直达控制台子页（如聚合渠道 agg），hash 路由与 showView 对齐
        string url = "http://127.0.0.1:" + port + "/console" + (string.IsNullOrEmpty(view) ? "" : "#/" + view);
        try { Process.Start(url); } catch { }
    }

    static string FindNode()
    {
        try
        {
            var psi = new ProcessStartInfo("where", "node");
            psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.CreateNoWindow = true;
            using (var p = Process.Start(psi))
            {
                string first = p.StandardOutput.ReadLine();
                p.WaitForExit(3000);
                if (!string.IsNullOrEmpty(first) && File.Exists(first.Trim())) return first.Trim();
            }
        }
        catch { }
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string guess = Path.Combine(pf, "nodejs", "node.exe");
        return File.Exists(guess) ? guess : "node";
    }

    public static void StartService()
    {
        string entry = Path.Combine(serverDir, "server.mjs");
        if (!File.Exists(entry))
        {
            MessageBox.Show("找不到服务入口：\n" + entry + "\n\n请确认客户端与插件目录同分发，或重新运行安装向导。",
                AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var psi = new ProcessStartInfo(FindNode(), "\"" + entry + "\"");
        psi.WorkingDirectory = serverDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
        for (int i = 0; i < 15; i++) { Thread.Sleep(1000); if (Health()) return; }
    }

    public static void StopService()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/admin/shutdown");
            req.Method = "POST"; req.Timeout = 5000; req.Proxy = null;
            req.Headers.Add("Authorization", "Bearer " + apiKey);
            using (var resp = (HttpWebResponse)req.GetResponse()) { }
        }
        catch { }
        for (int i = 0; i < 10; i++) { Thread.Sleep(500); if (!Health()) return; }
    }

    public static void RestartService() { if (Health()) StopService(); StartService(); }

    public static void RunBlocking(Action act)
    {
        try { act(); } catch (Exception ex) { MessageBox.Show(ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    public static void EnsureService() { if (!Health()) StartService(); }

    static string FindZcodeCli()
    {
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ZCode", "resources", "glm", "zcode.cjs"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
        };
        foreach (string c in candidates) { try { if (File.Exists(c)) return c; } catch { } }
        return null;
    }

    static string RunZcodeCli(string zcodeCli, string args)
    {
        var psi = new ProcessStartInfo(FindNode(), "\"" + zcodeCli + "\" " + args);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        using (var p = Process.Start(psi))
        {
            string so = p.StandardOutput.ReadToEnd();
            string se = p.StandardError.ReadToEnd();
            p.WaitForExit(120000);
            return so + Environment.NewLine + se;
        }
    }

    public static void InstallPluginToZcode()
    {
        string cli = FindZcodeCli();
        if (cli == null)
        {
            MessageBox.Show("没有找到 ZCode 的命令行入口（zcode.cjs）。\n\n常见位置：\n  %ProgramFiles%\\ZCode\\resources\\glm\\zcode.cjs\n\n请确认已安装 ZCode 桌面端。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        string listOut = RunZcodeCli(cli, "plugins list --json");
        if (listOut != null && listOut.Contains("workbuddy-bridge"))
        {
            MessageBox.Show("智能体里已经装了 WorkBuddy 积分桥插件，无需重复安装。\n\n如需更新版本：ZCode 插件页「浏览插件」里刷新市场后更新。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        string localMarket = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "market", "marketplace.json");
        string addSrc = File.Exists(localMarket)
            ? "\"" + Path.GetDirectoryName(localMarket) + "\""
            : "https://github.com/zhougonjin-ux/workbuddy-bridge-market";
        if (MessageBox.Show("将通过 ZCode 命令行把 WorkBuddy 积分桥插件装进智能体：\n\n  1. 添加插件市场（" + (File.Exists(localMarket) ? "本地自带" : "GitHub") + "）\n  2. 安装插件 workbuddy-bridge\n\n继续吗？（装完需重启 ZCode 生效）",
            AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

        string out1 = RunZcodeCli(cli, "plugins marketplace add " + addSrc);
        string out2 = RunZcodeCli(cli, "plugins install workbuddy-bridge@dev-workbuddy-bridge-local");
        bool ok = out2 != null && !System.Text.RegularExpressions.Regex.IsMatch(out2, "error|failed|未能", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        MessageBox.Show(ok
            ? "插件已装入智能体 ✅\n\n重启 ZCode 后生效；本客户端会自动拉起本地服务。\n模型选择器里会出现 WorkBuddy 分组（默认模型 id 填 default）。"
            : "安装输出（请截图反馈）：\n" + (out1 + "\n---\n" + out2).Trim(),
            AppName, MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    public static Icon MakeIcon(bool up)
    {
        using (Bitmap bmp = new Bitmap(16, 16))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (SolidBrush brush = new SolidBrush(up ? Color.FromArgb(5, 150, 105) : Color.FromArgb(150, 150, 150)))
                g.FillEllipse(brush, 2, 2, 12, 12);
            using (Pen pen = new Pen(Color.FromArgb(30, 30, 30)))
                g.DrawEllipse(pen, 2, 2, 12, 12);
            IntPtr hIcon = bmp.GetHicon();
            Icon clone = (Icon)Icon.FromHandle(hIcon).Clone();
            DestroyIcon(hIcon);
            return clone;
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}

/* ---------------- 主窗口：侧边栏导航 + 卡片页 ---------------- */

class MainForm : Form
{
    static readonly Color BodyBack = Color.FromArgb(246, 247, 249);
    static readonly Color CardBack = Color.White;
    static readonly Color InkText = Color.FromArgb(17, 24, 39);
    static readonly Color SubText = Color.FromArgb(107, 114, 128);
    static readonly Color Accent = Color.FromArgb(5, 150, 105);
    static readonly Color AccentDark = Color.FromArgb(4, 120, 87);
    static readonly Color Danger = Color.FromArgb(220, 38, 38);
    static readonly Color Warn = Color.FromArgb(180, 120, 10);
    static readonly Color BorderLine = Color.FromArgb(235, 238, 242);
    static readonly Color NavSel = Color.FromArgb(236, 248, 244);

    readonly Panel navPanel = new Panel();
    readonly Panel bodyPanel = new Panel();
    readonly List<NavButton> navButtons = new List<NavButton>();
    readonly Dictionary<string, Panel> pages = new Dictionary<string, Panel>();
    readonly Label navVersion = new Label();
    NotifyIcon tray;
    bool busy;
    DateTime acctMsgUntil = DateTime.MinValue; // 账号页提示占线至：60s 轮询在此前不得覆盖状态行
    bool modelsReloadQueued; // 模型页加载被 actionBusy 吞掉时排队，Run 收尾补跑
    bool settingsDirty, fillingSettings; // 设置页 dirty 守卫：用户改过未保存前，60s 轮询不回填          // 轮询互斥（RefreshAll 专用）
    bool actionBusy;    // 按钮动作互斥——与轮询分离：轮询进行中点击不再被静默吞掉（0.3.59）
    Label taskRunStatus;   // 任务页按钮的执行反馈（旧版点按钮零反馈，用户以为没点上）
    ListView modelList; Label modelCur; Label modelMsg; string modelsDefaultModel = "";

    // 聚合渠道页（0.3.62，入口形态对齐 dsh-xdpool / web 控制台）
    readonly ListView aggList = new ListView();
    readonly Label aggMsg = new Label();
    readonly Label aggCount = new Label();
    readonly CheckBox aggLaneCheck = new CheckBox();
    readonly System.Windows.Forms.TextBox aggNameBox = new System.Windows.Forms.TextBox();
    readonly System.Windows.Forms.TextBox aggUrlBox = new System.Windows.Forms.TextBox();
    readonly System.Windows.Forms.TextBox aggKeysBox = new System.Windows.Forms.TextBox();
    TextBox modelSearchBox;
    readonly List<string[]> modelRows = new List<string[]>();
    List<Dictionary<string, object>> aggProviders = new List<Dictionary<string, object>>();
    List<Dictionary<string, object>> aggPresets = new List<Dictionary<string, object>>();
    readonly System.Windows.Forms.ComboBox aggPresetCombo = new System.Windows.Forms.ComboBox();
    bool aggLane = true;
    bool fillingAggCombo;
    string currentPolicy = "";
    string pinnedId = "";

    // 账号管理页
    readonly System.Windows.Forms.ToolTip cardTips = new System.Windows.Forms.ToolTip();
    readonly Label alertLabel = new Label();
    readonly Label acctStatus = new Label();
    readonly FlowLayoutPanel accountCards = new FlowLayoutPanel();
    readonly Label accountEmpty = new Label();
    // 批量选择与筛选（0.3.72）：key = site + \0 + id
    readonly HashSet<string> selectedAccounts = new HashSet<string>();
    readonly List<string> visibleAccountKeys = new List<string>();
    ComboBox acctSortCombo;
    ComboBox acctSiteCombo;
    TextBox acctSearchBox;
    Label acctBulkStatus;

    // 任务中心页
    readonly Label kpiCredit = new Label();
    readonly Label kpiCheckins = new Label();
    readonly Label kpiClaims = new Label();
    readonly Label kpiTravels = new Label();
    readonly Label kpiStreaks = new Label();
    readonly Label todayExec = new Label();
    readonly Panel calendarPanel = new Panel();
    readonly ListView historyList = new ListView();
    Dictionary<string, object> checkinDaysData = new Dictionary<string, object>();
    readonly List<Dictionary<string, object>> lastRows = new List<Dictionary<string, object>>();
    readonly List<string[]> lastSiteLabels = new List<string[]>();
    readonly Label taskStatus = new Label();

    // 用量页
    readonly Label usageTodayCalls = new Label();
    readonly Label usageTodayCredit = new Label();
    readonly Label usageTotalCredit = new Label();
    readonly Label usageRecovered = new Label();
    readonly Panel hoursPanel = new Panel();
    readonly ListView topModels = new ListView();
    object todayHoursData = null;

    // 扫码登录页（0.3.64，形态对齐 dsh-xdpool）：厂商卡 + 设备授权登录
    readonly Label loginConnected = new Label();
    readonly Label loginBanner = new Label();
    readonly Label loginStatus = new Label();
    readonly Dictionary<string, Label> loginCountLabels = new Dictionary<string, Label>();
    readonly Dictionary<string, Button> loginAddButtons = new Dictionary<string, Button>();
    bool loginPolling;
    static readonly string[] LoginSites = { "codearts", "cn-cli", "intl-cli", "intl-work" };
    static readonly string[] LoginNames = { "CodeArts（华为云）", "WorkBuddy 国内版", "WorkBuddy 国际版", "WorkBuddy 国际工作版" };
    static readonly string[] LoginDescs = {
        "GLM-5.3-Flash · DeepSeek-V4.1-Flash 免费额度 + 每日签到积分，华为云账号 OAuth 授权（浏览器完成）",
        "与 CodeBuddy 共用端点：DeepSeek · Kimi · GLM 免费线，每日赠送积分",
        "codebuddy.ai 独立端点与账号体系：GPT · Claude · Gemini 阵容，积分与国内版不互通",
        "workbuddy.ai 工作台端点：独立账号体系，与国内/国际 CLI 互不相通",
    };
    static readonly Color[] LoginColors = { Color.FromArgb(225, 29, 72), Color.FromArgb(59, 130, 246), Color.FromArgb(16, 185, 129), Color.FromArgb(245, 158, 11) };

    // dsh-xdpool 支持网页/扫码登录的其它厂商目录（0.3.65）：本插件只代理 WorkBuddy/CodeBuddy
    // 账号体系，这几家没有端点适配，仅作目录展示（未接入置灰，按钮不可点）。
    static readonly string[] PendingNames = { "LobsterAI", "Qoder 国际版", "Qoder 国内版", "TRAE", "Cline" };
    static readonly string[] PendingVendors = { "有道", "阿里云", "阿里云", "字节跳动", "Cline Bot" };
    static readonly string[] PendingDescs = {
        "每日签到领积分，积分换模型调用额度",
        "每日 100 Credits，加密推理端点",
        "每日 100 Credits，国内端点与模型池",
        "手机号注册即送免费额度，按天重置",
        "绑定 GitHub 账号后送美元计价的免费额度；后端没有每日签到接口",
    };
    static readonly Color[] PendingColors = {
        Color.FromArgb(249, 115, 22), Color.FromArgb(99, 102, 241),
        Color.FromArgb(139, 92, 246), Color.FromArgb(20, 184, 166), Color.FromArgb(91, 33, 182),
    };

    // 数据看板页（0.3.64）：轮次/调用/失败/token/速度/缓存命中 + 最近调用
    readonly Label dashTokens = new Label();
    readonly Label dashTokensSub = new Label();
    readonly Label dashRounds = new Label();
    readonly Label dashRoundsSub = new Label();
    readonly Label dashFails = new Label();
    readonly Label dashFailsSub = new Label();
    readonly Label dashSpeed = new Label();
    readonly Label dashSpeedSub = new Label();
    readonly Label dashCache = new Label();
    readonly Label dashCacheSub = new Label();
    readonly Label dashRecovered = new Label();
    readonly Label dashRecoveredSub = new Label();
    readonly ListView dashRecent = new ListView();
    readonly Label dashStatus = new Label();

    // 设置页
    readonly ComboBox policyCombo = new ComboBox();
    readonly Label serviceStatus = new Label();
    readonly CheckBox budgetEnabledCheck = new CheckBox();
    readonly TextBox budgetDailyBox = new TextBox();
    readonly TextBox budgetWarnBox = new TextBox();
    readonly ComboBox budgetModeCombo = new ComboBox();
    readonly CheckBox taskEnabledCheck = new CheckBox();
    readonly CheckBox checkinCheck = new CheckBox();
    readonly CheckBox growthCheck = new CheckBox();
    readonly CheckBox reportCheck = new CheckBox();
    readonly TextBox reportTimesBox = new TextBox();
    readonly TextBox checkinTimesBox = new TextBox();
    readonly Label cfgStatus = new Label();

    public MainForm()
    {
        Text = Program.AppName;
        MinimizeBox = true;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1020, 680);
        MinimumSize = new Size(920, 600);
        BackColor = BodyBack;
        DoubleBuffered = true;
        Font = new Font("Microsoft YaHei UI", 9F);

        BuildSidebar();
        BuildBody();
        ShowPage("accounts");

        Icon = Program.MakeIcon(true);
        BuildTray();

        var timer = new System.Windows.Forms.Timer { Interval = 60000 };
        timer.Tick += delegate { if (!busy) RefreshAll(); };
        timer.Start();
        Load += delegate { RestoreWindowState(); RefreshAll(); };
    }

    /** 窗口尺寸/位置记忆：%LOCALAPPDATA%\WorkBuddyBridge\ui.txt（安装目录可写，Program Files 不一定）。 */
    static string UiStatePath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkBuddyBridge", "ui.txt");
    }

    void RestoreWindowState()
    {
        try
        {
            string p = UiStatePath();
            if (!File.Exists(p)) return;
            string[] parts = File.ReadAllText(p).Split(',');
            if (parts.Length < 5) return;
            int x, y, w, h;
            if (!int.TryParse(parts[0], out x) || !int.TryParse(parts[1], out y)
                || !int.TryParse(parts[2], out w) || !int.TryParse(parts[3], out h)) return;
            if (w < 920 || h < 600) return;
            // 显示器变过（拔掉副屏/改分辨率）时不要恢复到场外，保持居中
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            if (x < wa.Left - 50 || y < wa.Top - 50 || x > wa.Right - 200 || y > wa.Bottom - 100) return;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(x, y);
            ClientSize = new Size(w, h);
            if (parts[4].Trim() == "1") WindowState = FormWindowState.Maximized;
        }
        catch { /* 状态文件坏了就按默认居中打开 */ }
    }

    void SaveWindowState()
    {
        try
        {
            string p = UiStatePath();
            Directory.CreateDirectory(Path.GetDirectoryName(p));
            bool max = WindowState == FormWindowState.Maximized;
            Rectangle r = max ? RestoreBounds : Bounds;
            File.WriteAllText(p, r.X + "," + r.Y + "," + ClientSize.Width + "," + ClientSize.Height + "," + (max ? "1" : "0"));
        }
        catch { /* 保存失败不影响关闭 */ }
    }

    void BuildTray()
    {
        // 复用 Program 的主托盘图标：旧版这里又 new 一个 NotifyIcon 且 Visible=true，
        // 托盘区会出现两个相同图标；而且这里的简化菜单会覆盖 Program 的启动/停止/重启项。
        tray = Program.tray;
        if (tray == null)
        {
            tray = new NotifyIcon();
            tray.Icon = Program.MakeIcon(true);
            tray.Text = Program.AppName;
            tray.Visible = true;
        }
        Program.BuildTrayMenu();
    }

    void BuildSidebar()
    {
        navPanel.Dock = DockStyle.Left;
        navPanel.Width = 184;
        navPanel.BackColor = Color.White;

        var logoDot = new Label { Text = "", Location = new Point(18, 22), Size = new Size(14, 14), BackColor = Accent };
        SetRound(logoDot, 7);
        var logoText = new Label
        {
            Text = "WorkBuddy 积分桥",
            Location = new Point(40, 16), Size = new Size(140, 26),
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold), ForeColor = InkText,
        };
        navPanel.Controls.Add(logoDot);
        navPanel.Controls.Add(logoText);

        AddNav("账号管理", "accounts", 68);
        AddNav("扫码登录", "login", 110);
        AddNav("任务中心", "tasks", 152);
        AddNav("模型", "models", 194);
        AddNav("聚合渠道", "agg", 236);
        AddNav("数据看板", "dash", 278);
        AddNav("用量", "usage", 320);
        AddNav("设置", "settings", 362);

        navVersion.Dock = DockStyle.Bottom;
        navVersion.Height = 36;
        navVersion.Text = "v" + Program.pluginVersion;
        navVersion.ForeColor = SubText;
        navVersion.Font = new Font("Microsoft YaHei UI", 8F);
        navVersion.TextAlign = ContentAlignment.MiddleLeft;
        navVersion.Padding = new Padding(18, 0, 0, 0);
        navPanel.Controls.Add(navVersion);

        Controls.Add(navPanel);
        navPanel.BringToFront();
    }

    void AddNav(string text, string page, int y)
    {
        var btn = new NavButton(text);
        btn.Location = new Point(10, y);
        btn.Size = new Size(164, 36);
        btn.Click += delegate { ShowPage(page); };
        navButtons.Add(btn);
        navPanel.Controls.Add(btn);
    }

    class NavButton : Control
    {
        public bool Selected;
        readonly string text;
        public NavButton(string t)
        {
            text = t;
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var b = new SolidBrush(Selected ? NavSel : BackColor))
                FillRound(e.Graphics, b, 0, 0, Width - 1, Height - 1, 8);
            TextRenderer.DrawText(e.Graphics, text,
                new Font("Microsoft YaHei UI", 9.25F, Selected ? FontStyle.Bold : FontStyle.Regular),
                new Rectangle(14, 0, Width - 16, Height),
                Selected ? Color.FromArgb(4, 108, 78) : Color.FromArgb(55, 65, 81),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
        }
    }

    static void FillRound(Graphics g, Brush b, int x, int y, int w, int h, int r)
    {
        using (var p = RoundPath(x, y, w, h, r)) g.FillPath(b, p);
    }

    static System.Drawing.Drawing2D.GraphicsPath RoundPath(int x, int y, int w, int h, int r)
    {
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        path.AddArc(x, y, r * 2, r * 2, 180, 90);
        path.AddArc(x + w - r * 2, y, r * 2, r * 2, 270, 90);
        path.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
        path.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
        path.CloseFigure();
        return path;
    }

    void SetRound(Control c, int r)
    {
        c.Region = new Region(RoundPath(0, 0, c.Width, c.Height, r));
    }

    void BuildBody()
    {
        bodyPanel.Dock = DockStyle.Fill;
        bodyPanel.BackColor = BodyBack;

        pages["accounts"] = BuildAccountsPage();
        pages["login"] = BuildLoginPage();
        pages["tasks"] = BuildTasksPage();
        pages["models"] = BuildModelsPage();
        pages["agg"] = BuildAggPage();
        pages["dash"] = BuildDashPage();
        pages["usage"] = BuildUsagePage();
        pages["settings"] = BuildSettingsPage();
        foreach (var p in pages.Values) bodyPanel.Controls.Add(p);
        Controls.Add(bodyPanel);
        bodyPanel.BringToFront();
    }

    static Label PageTitle(string text)
    {
        return new Label { Text = text, Location = new Point(32, 24), Font = new Font("Microsoft YaHei UI", 15.5F, FontStyle.Bold), ForeColor = InkText, AutoSize = true };
    }
    static Label PageSub(string text, int y)
    {
        return new Label { Text = text, Location = new Point(32, y), Font = new Font("Microsoft YaHei UI", 9F), ForeColor = SubText, AutoSize = true };
    }

    static Button GreenButton(string text)
    {
        var b = new Button { Text = text, FlatStyle = FlatStyle.Flat, Size = new Size(150, 34), Cursor = Cursors.Hand };
        b.BackColor = Accent; b.ForeColor = Color.White;
        b.FlatAppearance.BorderSize = 0;
        b.Font = new Font("Microsoft YaHei UI", 9.25F);
        b.MouseEnter += delegate { b.BackColor = AccentDark; };
        b.MouseLeave += delegate { b.BackColor = Accent; };
        return b;
    }

    Button PlainButton(string text)
    {
        var b = new Button { Text = text, FlatStyle = FlatStyle.Flat, Size = new Size(150, 34), Cursor = Cursors.Hand };
        b.BackColor = CardBack; b.ForeColor = InkText;
        b.FlatAppearance.BorderColor = BorderLine;
        b.Font = new Font("Microsoft YaHei UI", 9.25F);
        b.MouseEnter += delegate { b.BackColor = Color.FromArgb(243, 244, 246); };
        b.MouseLeave += delegate { b.BackColor = CardBack; };
        return b;
    }

    void AddBtn(FlowLayoutPanel panel, string text, Action act)
    {
        var b = new Button { Text = text, Size = new Size(118, 32), Margin = new Padding(2) };
        b.FlatStyle = FlatStyle.Flat;
        b.BackColor = CardBack; b.ForeColor = InkText;
        b.FlatAppearance.BorderColor = BorderLine;
        b.Font = new Font("Microsoft YaHei UI", 9F);
        b.Cursor = Cursors.Hand;
        b.MouseEnter += delegate { b.BackColor = Color.FromArgb(243, 244, 246); };
        b.MouseLeave += delegate { b.BackColor = CardBack; };
        b.Click += delegate
        {
            // 0.3.59：不再在此层做 busy 门控——旧版与 60s 轮询共用 busy，轮询进行中点击被
            // 静默吞掉（用户「点了没反应」的根源）。所有调用点的 act 都自带线程与互斥（Run/RunBlocking）。
            act();
        };
        panel.Controls.Add(b);
    }

    Panel BuildAccountsPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill };
        page.Controls.Add(PageTitle("账号管理"));
        page.Controls.Add(PageSub("统一管理 WorkBuddy / CodeBuddy 账号：余额、到期批次、登录状态。", 60));

        alertLabel.Location = new Point(32, 92);
        alertLabel.Size = new Size(900, 26);
        alertLabel.Visible = false;
        alertLabel.Font = new Font("Microsoft YaHei UI", 9F);
        alertLabel.ForeColor = Color.White;
        alertLabel.BackColor = Danger;
        alertLabel.TextAlign = ContentAlignment.MiddleLeft;
        alertLabel.Padding = new Padding(8, 0, 0, 0);
        page.Controls.Add(alertLabel);

        var addBtn = GreenButton("OAuth 扫码添加");
        addBtn.Location = new Point(32, 128);
        addBtn.Click += delegate
        {
            // 0.3.64：客户端自己支持设备授权登录了（原先是开网页控制台引导），直达「扫码登录」页
            ShowPage("login");
        };
        var importBtn = PlainButton("导入本机账号");
        importBtn.Location = new Point(192, 128);
        importBtn.Click += delegate
        {
            RunAcctWithStatus("导入", delegate
            {
                string outText = Program.Api("POST", "/console/api/local/import", "{}");
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                var d = ser.DeserializeObject(outText) as Dictionary<string, object>;
                return "导入完成 ✓ 新增 " + Int(d, "imported") + " · 更新 " + Int(d, "updated") + " · 跳过 " + Int(d, "skipped")
                    + "（扫描 " + Int(d, "scannedFiles") + " 个客户端目录，无变化即全部跳过）";
            });
        };
        var refreshBtn = PlainButton("刷新");
        refreshBtn.Location = new Point(352, 128);
        refreshBtn.Click += delegate
        {
            RunAcctWithStatus("刷新积分", delegate
            {
                string outText = Program.Api("POST", "/console/api/credit/refresh", "{}");
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                var d = ser.DeserializeObject(outText) as Dictionary<string, object>;
                int total = 0, fail = 0;
                var failSites = new List<string>();
                object rv;
                if (d != null && d.TryGetValue("results", out rv))
                {
                    var bySite = rv as Dictionary<string, object>;
                    if (bySite != null)
                    {
                        foreach (var kv in bySite)
                        {
                            var items = kv.Value as object[];
                            if (items == null) continue;
                            foreach (var item in items)
                            {
                                var m = item as Dictionary<string, object>;
                                if (m == null) continue;
                                total++;
                                object ov;
                                bool ok = m.TryGetValue("ok", out ov) && ov is bool && (bool)ov;
                                if (!ok)
                                {
                                    fail++;
                                    if (failSites.Count < 3 && !failSites.Contains(kv.Key)) failSites.Add(kv.Key);
                                }
                            }
                        }
                    }
                }
                return fail == 0
                    ? "积分刷新完成 ✓ " + total + " 个账号全部成功"
                    : "积分刷新完成 ✓ " + (total - fail) + "/" + total + " 个成功，" + fail + " 个失败（" + string.Join("、", failSites.ToArray()) + (fail > 3 ? " 等" : "") + "，详情见网页控制台）";
            });
        };
        page.Controls.Add(addBtn);
        page.Controls.Add(importBtn);
        page.Controls.Add(refreshBtn);

        // 批量操作行（0.3.72）：全选 + 批量启停/删除/保留线
        var bulkRow = new FlowLayoutPanel { Location = new Point(32, 164), Size = new Size(900, 32) };
        var selectAll = new CheckBox { Text = "全选当前", AutoSize = true, Margin = new Padding(0, 7, 8, 0) };
        selectAll.CheckedChanged += delegate
        {
            if (selectAll.Checked) foreach (var k in visibleAccountKeys) selectedAccounts.Add(k);
            else selectedAccounts.Clear();
            RebuildCards();
        };
        bulkRow.Controls.Add(selectAll);
        AddBtn(bulkRow, "批量启用", delegate { BulkSetEnabled(true); });
        AddBtn(bulkRow, "批量禁用", delegate { BulkSetEnabled(false); });
        AddBtn(bulkRow, "批量设保留线", delegate { BulkSetMin(); });
        AddBtn(bulkRow, "批量删除", delegate { BulkRemove(); });
        acctBulkStatus = new Label { AutoSize = true, ForeColor = SubText, Margin = new Padding(8, 8, 0, 0), Text = "" };
        bulkRow.Controls.Add(acctBulkStatus);
        page.Controls.Add(bulkRow);

        // 排序 / 站点筛选 / 搜索
        var filterRow = new FlowLayoutPanel { Location = new Point(32, 200), Size = new Size(900, 30) };
        acctSortCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Size = new Size(150, 26), Margin = new Padding(0, 2, 8, 0) };
        acctSortCombo.Items.AddRange(new object[] { "默认顺序", "积分到期优先", "余额从多到少", "异常优先" });
        acctSortCombo.SelectedIndex = 0;
        acctSortCombo.SelectedIndexChanged += delegate { RebuildCards(); };
        acctSiteCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Size = new Size(130, 26), Margin = new Padding(0, 2, 8, 0) };
        acctSiteCombo.Items.Add("全部站点");
        acctSiteCombo.SelectedIndex = 0;
        acctSiteCombo.SelectedIndexChanged += delegate { RebuildCards(); };
        acctSearchBox = new TextBox { Size = new Size(200, 24), Margin = new Padding(0, 3, 8, 0) };
        acctSearchBox.TextChanged += delegate { RebuildCards(); };
        filterRow.Controls.Add(acctSortCombo);
        filterRow.Controls.Add(acctSiteCombo);
        filterRow.Controls.Add(new Label { Text = "搜索", AutoSize = true, Margin = new Padding(0, 8, 4, 0) });
        filterRow.Controls.Add(acctSearchBox);
        page.Controls.Add(filterRow);

        acctStatus.Location = new Point(32, 238);
        acctStatus.Size = new Size(880, 20);
        acctStatus.ForeColor = SubText;
        page.Controls.Add(acctStatus);

        accountCards.Location = new Point(32, 264);
        accountCards.Size = new Size(700, 440);
        accountCards.FlowDirection = FlowDirection.TopDown;
        accountCards.WrapContents = false;
        accountCards.AutoScroll = true;
        // 横滚硬禁：即使内部有超宽残留也不显示横滚条（卡宽算法已保不超宽，这里双保险）
        accountCards.HorizontalScroll.Enabled = false;
        accountCards.HorizontalScroll.Visible = false;
        accountCards.Resize += delegate
        {
            // 容器宽度变化（窗口缩放/纵滚条出现）→ 所有卡同步调宽；卡内按钮由卡自己的 Resize 重定位
            var w = Math.Max(420, accountCards.ClientSize.Width - 26);
            foreach (Control c in accountCards.Controls) c.Width = w;
        };
        page.Controls.Add(accountCards);

        // 宽度一律靠页面 Resize 显式计算，绝不用 Anchor：页面在 Dock 之前是默认 200x100，
        // 锚定差值按 200 宽建立，页面被 Dock 拉到 800+ 后容器会被撑爆（曾经 accountCards 撑到 1349，按钮全被顶出窗外）。
        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            alertLabel.Width = w;
            acctStatus.Width = w;
            accountCards.Width = w;
            accountCards.Height = Math.Max(120, page.ClientSize.Height - 280);
        };

        accountEmpty.Text = "还没有账号——点「OAuth 扫码添加」或「导入本机账号」";
        accountEmpty.Location = new Point(32, 274);
        accountEmpty.ForeColor = SubText;
        page.Controls.Add(accountEmpty);
        return page;
    }

    Panel BuildTasksPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("任务中心"));
        page.Controls.Add(PageSub("积分自动化：签到、成长任务报名与代打、猫猫旅行、活跃上报。全部幂等，随时可点。", 60));

        var btnPanel = new FlowLayoutPanel { Location = new Point(32, 100), Size = new Size(900, 44) };
        AddBtn(btnPanel, "立即签到", delegate { RunTask("checkin"); });
        AddBtn(btnPanel, "一键代打全部", delegate { RunPlayAll(); });
        AddBtn(btnPanel, "成长任务", delegate { RunTask("growth"); });
        AddBtn(btnPanel, "猫猫巡逻", delegate { RunTask("travel"); });
        AddBtn(btnPanel, "活跃上报", delegate { RunTask("report"); });
        AddBtn(btnPanel, "连登管家", delegate { RunTask("streak"); });
        page.Controls.Add(btnPanel);
        // 执行反馈行（0.3.59）：放在标题右侧，不挤占下方任何布局
        taskRunStatus = new Label { Location = new Point(210, 26), AutoSize = true, ForeColor = Accent, Font = new Font("Microsoft YaHei UI", 9F), Text = "" };
        page.Controls.Add(taskRunStatus);

        var kpiCards = new List<Panel>();
        kpiCards.Add(AddKpiCard(page, "累计白嫖积分", kpiCredit, 32, 156));
        kpiCards.Add(AddKpiCard(page, "签到次数", kpiCheckins, 208, 156));
        kpiCards.Add(AddKpiCard(page, "领奖次数", kpiClaims, 384, 156));
        kpiCards.Add(AddKpiCard(page, "猫猫到站", kpiTravels, 560, 156));
        kpiCards.Add(AddKpiCard(page, "连登兑换", kpiStreaks, 736, 156));

        var execCaption = new Label { Text = "今日执行", Location = new Point(32, 268), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        todayExec.Location = new Point(32, 294);
        todayExec.Size = new Size(880, 140);
        todayExec.ForeColor = InkText;
        page.Controls.Add(execCaption);
        page.Controls.Add(todayExec);

        var calCaption = new Label { Text = "签到日历（近 8 周）", Location = new Point(32, 444), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        calendarPanel.Location = new Point(32, 470);
        calendarPanel.Size = new Size(500, 130);
        calendarPanel.BackColor = CardBack;
        calendarPanel.Paint += CalendarPaint;
        page.Controls.Add(calCaption);
        page.Controls.Add(calendarPanel);

        var histCaption = new Label { Text = "最近记录", Location = new Point(552, 444), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        historyList.Location = new Point(552, 470);
        historyList.Size = new Size(380, 130);
        historyList.View = View.Details;
        historyList.FullRowSelect = true;
        historyList.HeaderStyle = ColumnHeaderStyle.None;
        historyList.Columns.Add("时间", 110);
        historyList.Columns.Add("详情", 250);
        historyList.Font = new Font("Microsoft YaHei UI", 8.5F);
        page.Controls.Add(histCaption);
        page.Controls.Add(historyList);

        // 页级横滚硬禁 + 宽度随页面 Resize 显式铺排（KPI 五卡等距、日历右边的记录表吃剩余宽）
        page.HorizontalScroll.Enabled = false;
        page.HorizontalScroll.Visible = false;
        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            btnPanel.Width = w;
            todayExec.Width = w;
            int kw = (w - 4 * 16) / 5;
            if (kw > 160) kw = 160;
            if (kw < 96) kw = 96;
            for (int i = 0; i < kpiCards.Count; i++)
            {
                kpiCards[i].Width = kw;
                kpiCards[i].Location = new Point(32 + i * (kw + 16), 156);
            }
            int hw = w - 520;
            if (hw < 240) hw = 240;
            historyList.Width = hw;
            historyList.Columns[1].Width = Math.Max(80, hw - 130);
        };
        return page;
    }

    Panel AddKpiCard(Panel page, string title, Label valueLabel, int x, int y)
    {
        var card = new Panel { Location = new Point(x, y), Size = new Size(160, 92), BackColor = CardBack };
        var t = new Label { Text = title, Location = new Point(14, 14), ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 9F), AutoSize = true };
        valueLabel.Location = new Point(14, 42);
        valueLabel.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
        valueLabel.ForeColor = InkText;
        valueLabel.Text = "0";
        valueLabel.AutoSize = true;
        card.Controls.Add(t);
        card.Controls.Add(valueLabel);
        card.Paint += delegate (object s, PaintEventArgs e)
        {
            using (var pen = new Pen(BorderLine)) e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
        };
        page.Controls.Add(card);
        return card;
    }

    void CalendarPaint(object s, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(CardBack);
        int cell = 16, gap = 3, x0 = 12, y0 = 10;
        var today = DateTime.Today;
        var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
        for (int i = 55; i >= 0; i--)
        {
            var day = today.AddDays(-i);
            string key = day.ToString("yyyy-MM-dd");
            int count = 0;
            if (checkinDaysData.ContainsKey(key))
            {
                try
                {
                    var arr = ser.DeserializeObject(ser.Serialize(checkinDaysData[key])) as object[];
                    if (arr != null) count = arr.Length;
                }
                catch { count = 0; }
            }
            int col = (55 - i) % 14, row = (55 - i) / 14;
            int x = x0 + col * (cell + gap), y = y0 + row * (cell + gap);
            Color c = count == 0 ? Color.FromArgb(233, 236, 239) : count == 1 ? Color.FromArgb(134, 214, 178) : Accent;
            using (var b = new SolidBrush(c)) g.FillRectangle(b, x, y, cell, cell);
            if (i == 0) using (var pen = new Pen(Danger)) g.DrawRectangle(pen, x - 1, y - 1, cell + 2, cell + 2);
        }
        TextRenderer.DrawText(g, "浅绿=部分账号已签 · 深绿=全部 · 红框=今天",
            new Font("Microsoft YaHei UI", 8F), new Point(x0, y0 + 4 * (cell + gap) + 6), SubText);
    }

    /** 模型页（0.3.59）：目录/倍率/促销/限流 + 设默认——此前这些只在网页控制台可见。 */
    Panel BuildModelsPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("模型"));
        page.Controls.Add(PageSub("可用模型目录与限流状态（跟随上游刷新）；★ = 当前默认模型，双击行或按钮设为默认。", 60));

        modelCur = new Label { Location = new Point(32, 86), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold), Text = "当前默认模型：—" };
        page.Controls.Add(modelCur);

        var topRow = new FlowLayoutPanel { Location = new Point(32, 112), Size = new Size(900, 36) };
        AddBtn(topRow, "⟳ 刷新列表", delegate { LoadModels(); });
        AddBtn(topRow, "设选中为默认", delegate { SetDefaultModelFromSelection(); });
        AddBtn(topRow, "🔗 聚合渠道", delegate { ShowPage("agg"); });
        modelSearchBox = new TextBox { Size = new Size(170, 24), Margin = new Padding(8, 6, 4, 0) };
        modelSearchBox.TextChanged += delegate { RenderModelRows(); };
        topRow.Controls.Add(new Label { Text = "搜索", AutoSize = true, Margin = new Padding(8, 9, 2, 0) });
        topRow.Controls.Add(modelSearchBox);
        modelMsg = new Label { AutoSize = true, ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 9F), Text = "", Margin = new Padding(8, 7, 4, 4) };
        topRow.Controls.Add(modelMsg);
        page.Controls.Add(topRow);

        modelList = new ListView();
        modelList.Location = new Point(32, 156);
        modelList.Size = new Size(880, 520);
        modelList.View = View.Details;
        modelList.FullRowSelect = true;
        modelList.Font = new Font("Microsoft YaHei UI", 9F);
        modelList.Columns.Add("模型", 240);
        modelList.Columns.Add("站点", 90);
        modelList.Columns.Add("倍率", 90);
        modelList.Columns.Add("促销", 130);
        modelList.Columns.Add("上下文", 90);
        modelList.Columns.Add("限流", 160);
        modelList.DoubleClick += delegate { SetDefaultModelFromSelection(); };
        page.Controls.Add(modelList);

        page.HorizontalScroll.Enabled = false;
        page.HorizontalScroll.Visible = false;
        page.Resize += delegate { modelList.Width = Math.Max(360, page.ClientSize.Width - 64); };
        return page;
    }

    void SetDefaultModelFromSelection()
    {
        if (modelList == null || modelList.SelectedItems.Count == 0)
        {
            if (modelMsg != null) modelMsg.Text = "先在列表里选中一个模型";
            return;
        }
        string id = modelList.SelectedItems[0].SubItems[0].Text;
        if (id.StartsWith("★ ")) id = id.Substring(2);
        string picked = id;
        if (modelMsg != null) modelMsg.Text = "设置默认：" + picked + " …";
        // 重载必须走 after（UI 线程、actionBusy 已清）——绝不能在 Run 体内直接调 LoadModels：
        // 工作线程跨线程改控件抛异常，且嵌套 Run 被 actionBusy 门静默吞掉（0.3.60 双击失败根因）
        Run(delegate
        {
            Program.Api("POST", "/console/api/default-model", "{\"model\":\"" + J(picked) + "\"}");
        }, delegate
        {
            LoadModels();
            if (modelMsg != null) { modelMsg.Text = "默认模型 → " + picked + " ✓"; modelMsg.ForeColor = Accent; }
        });
    }

    void LoadModels()
    {
        if (modelMsg != null)
        {
            modelMsg.ForeColor = SubText;
            modelMsg.Text = "加载中…";
        }
        bool started = Run(delegate
        {
            string json = Program.Api("GET", "/console/api/models", null);
            var ser = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var root = ser.DeserializeObject(json) as Dictionary<string, object>;
            string defModel = Str(root, "default_model");
            object[] data = root != null && root.ContainsKey("data") ? root["data"] as object[] : null;
            var rows = new List<string[]>();
            foreach (var o in data ?? new object[0])
            {
                var m = o as Dictionary<string, object>;
                if (m == null) continue;
                string id = Str(m, "id");
                if (id == "") continue;
                double mult;
                double.TryParse(Str(m, "multiplier"), out mult);
                string multText = Str(m, "free") == "True" ? "免费" : (Str(m, "multiplier") == "" ? "—" : "x" + mult.ToString("0.##"));
                string badges = "";
                object bv;
                if (m.TryGetValue("badges", out bv) && bv is object[])
                {
                    var parts = new List<string>();
                    foreach (var v in (object[])bv) if (v != null && v.ToString() != "") parts.Add(v.ToString());
                    badges = string.Join("、", parts.ToArray());
                }
                double ctx;
                double.TryParse(Str(m, "context"), out ctx);
                string ctxText = ctx > 0 ? (ctx / 1000.0).ToString("0.#") + "K" : "—";
                string rate = "—";
                object rv;
                if (m.TryGetValue("rate_limit", out rv) && rv is Dictionary<string, object>)
                {
                    double until;
                    double.TryParse(Str((Dictionary<string, object>)rv, "until"), out until);
                    rate = "限流中 → " + (until > 0 ? new DateTime(1970, 1, 1).AddMilliseconds(until).ToLocalTime().ToString("HH:mm") : "?") + " 恢复";
                }
                rows.Add(new string[] { (id == defModel ? "★ " : "") + id, Str(m, "site"), multText, badges, ctxText, rate });
            }
            BeginInvoke((MethodInvoker)delegate
            {
                modelsDefaultModel = defModel;
                modelCur.Text = "当前默认模型：" + (defModel == "" ? "—" : defModel);
                modelRows.Clear();
                foreach (var r in rows) modelRows.Add(r);
                if (modelMsg != null) modelMsg.Text = "共 " + rows.Count + " 个模型";
                RenderModelRows();
            });
        });
        if (!started)
        {
            modelsReloadQueued = true; // 忙碌期被吞：Run 收尾自动补跑
            if (modelMsg != null) modelMsg.Text = "加载中…（等待当前操作完成）";
        }
    }

    /** 按搜索词重绘模型列表（模型/站点/促销列都参与匹配）。 */
    void RenderModelRows()
    {
        if (modelList == null) return;
        string q = modelSearchBox != null ? modelSearchBox.Text.Trim().ToLowerInvariant() : "";
        modelList.BeginUpdate();
        modelList.Items.Clear();
        int shown = 0;
        foreach (var r in modelRows)
        {
            if (q != "")
            {
                string hay = string.Join(" ", r).ToLowerInvariant();
                if (!hay.Contains(q)) continue;
            }
            modelList.Items.Add(new ListViewItem(r));
            shown++;
        }
        modelList.EndUpdate();
        if (modelMsg != null && q != "") modelMsg.Text = "筛选到 " + shown + "/" + modelRows.Count + " 个模型";
    }

    /** 聚合渠道页（0.3.62）：与 web 控制台同款能力——总开关、渠道增删启停、拉取模型。
        keys 从服务端来的是打码值（sk-xxx…），保存时服务端会把打码值还原成原 key。 */
    Panel BuildAggPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("聚合渠道"));
        page.Controls.Add(PageSub("自有 key 的 OpenAI 兼容 provider 接进同一个模型池；默认一家都不接，填上 key 它的模型才进选择器（ID 形如 agg:渠道/模型，多 key 自动轮换）。", 60));

        aggLaneCheck.Text = "聚合开关";
        aggLaneCheck.Location = new Point(32, 92);
        aggLaneCheck.AutoSize = true;
        aggLaneCheck.Checked = true;
        aggLaneCheck.ThreeState = false;
        aggLaneCheck.CheckedChanged += delegate { if (aggList.Items.Count == 0) return; aggLane = aggLaneCheck.Checked; SaveAgg(aggLane ? "聚合开关已打开" : "聚合开关已关闭（渠道保留，不再贡献模型）"); };
        page.Controls.Add(aggLaneCheck);
        aggCount.Location = new Point(140, 94);
        aggCount.AutoSize = true;
        aggCount.ForeColor = Accent;
        aggCount.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        aggCount.Text = "—";
        page.Controls.Add(aggCount);

        aggList.Location = new Point(32, 122);
        aggList.Size = new Size(880, 300);
        aggList.View = View.Details;
        aggList.FullRowSelect = true;
        aggList.Font = new Font("Microsoft YaHei UI", 9F);
        aggList.Columns.Add("渠道", 110);
        aggList.Columns.Add("状态", 76);
        aggList.Columns.Add("接口地址", 350);
        aggList.Columns.Add("Keys", 240);
        page.Controls.Add(aggList);

        var opRow = new FlowLayoutPanel { Location = new Point(32, 432), Size = new Size(900, 40) };
        AddBtn(opRow, "启用选中", delegate { SetAggSelectedEnabled(true); });
        AddBtn(opRow, "停用选中", delegate { SetAggSelectedEnabled(false); });
        AddBtn(opRow, "删除选中", delegate
        {
            if (aggList.SelectedItems.Count == 0) { SetAggMsg("先选中一行", SubText); return; }
            string name = Str(aggProviders[aggList.SelectedIndices[0]], "name");
            aggProviders.RemoveAt(aggList.SelectedIndices[0]);
            RenderAggList();
            SaveAgg("已删除 " + name);
        });
        AddBtn(opRow, "⟳ 拉取模型", delegate
        {
            SetAggMsg("拉取中…", SubText);
            Run(delegate
            {
                Program.Api("POST", "/console/api/aggregate/refresh", "{}");
                LoadAgg();
            }, delegate { SetAggMsg("模型目录已刷新（新渠道的模型已进选择器）", Accent); });
        });
        page.Controls.Add(opRow);

        var addCaption = new Label { Text = "添加渠道", Location = new Point(32, 484), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        page.Controls.Add(addCaption);
        var presetCaption = new Label { Text = "常用厂商（选一个，地址自动带出，只需贴 key）：", Location = new Point(32, 510), AutoSize = true, ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 9F) };
        page.Controls.Add(presetCaption);
        aggPresetCombo.Location = new Point(32, 532);
        aggPresetCombo.Size = new Size(360, 24);
        aggPresetCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        aggPresetCombo.Font = new Font("Microsoft YaHei UI", 9F);
        aggPresetCombo.SelectedIndexChanged += delegate
        {
            if (fillingAggCombo || aggPresetCombo.SelectedIndex < 0) return;
            var p = aggPresets[aggPresetCombo.SelectedIndex];
            aggNameBox.Text = Str(p, "id");
            aggUrlBox.Text = Str(p, "baseUrl");
            string ku = Str(p, "keyUrl");
            SetAggMsg("已选 " + Str(p, "name") + (ku != "" ? " · 申请 key：" + ku : "") + " —— 现在贴 key 点「＋ 添加渠道」", SubText);
        };
        page.Controls.Add(aggPresetCombo);
        aggNameBox.Location = new Point(32, 510); aggNameBox.Width = 140;
        aggUrlBox.Location = new Point(182, 510); aggUrlBox.Width = 320;
        aggKeysBox.Location = new Point(512, 510);
        aggNameBox.Font = aggUrlBox.Font = aggKeysBox.Font = new Font("Microsoft YaHei UI", 9F);
        page.Controls.Add(aggNameBox); page.Controls.Add(aggUrlBox); page.Controls.Add(aggKeysBox);
        var addRow = new FlowLayoutPanel { Location = new Point(32, 602), Size = new Size(900, 40) };
        AddBtn(addRow, "＋ 添加渠道", delegate
        {
            string name = aggNameBox.Text.Trim();
            string url = aggUrlBox.Text.Trim();
            var keys = new List<string>();
            foreach (var k in aggKeysBox.Text.Split(new[] { ',', '，', ';', '；', ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var t = k.Trim();
                if (t != "") keys.Add(t);
            }
            if (name == "" || url == "" || keys.Count == 0) { SetAggMsg("渠道名 / 接口地址 / key 都要填", Danger); return; }
            if (!url.StartsWith("http://") && !url.StartsWith("https://")) { SetAggMsg("接口地址必须是 http(s):// 开头", Danger); return; }
            if (aggProviders.Exists(delegate (Dictionary<string, object> p) { return Str(p, "name") == name; })) { SetAggMsg("渠道 " + name + " 已存在", Danger); return; }
            var d = new Dictionary<string, object>();
            d["name"] = name; d["baseUrl"] = url; d["apiKeys"] = keys.ToArray(); d["enabled"] = true;
            aggProviders.Add(d);
            aggNameBox.Text = ""; aggUrlBox.Text = ""; aggKeysBox.Text = "";
            RenderAggList();
            SaveAgg("已添加 " + name);
        });
        addRow.Controls.Add(aggMsg);
        page.Controls.Add(addRow);

        var hint = new Label { Text = "提示：关掉聚合开关不影响 WorkBuddy 账号池；停用渠道会保留 key 只摘出池子。删除/启停/添加都会立即保存。", Location = new Point(32, 652), AutoSize = true, ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 8.5F) };
        page.Controls.Add(hint);

        page.HorizontalScroll.Enabled = false;
        page.HorizontalScroll.Visible = false;
        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            aggList.Width = w;
            aggList.Columns[2].Width = Math.Max(140, w - 110 - 76 - 240 - 26); // 地址列吃剩余宽度，禁横滚（0.3.63）
            opRow.Width = w; addRow.Width = w;
            aggUrlBox.Width = Math.Max(200, w - 140 - 240 - 20);
            aggKeysBox.Width = 240;
        };
        return page;
    }

    void SetAggMsg(string text, Color c)
    {
        aggMsg.Text = text;
        aggMsg.ForeColor = c;
        aggMsg.AutoSize = true;
        aggMsg.Margin = new Padding(8, 7, 4, 4);
    }

    void RenderAggList()
    {
        aggList.BeginUpdate();
        aggList.Items.Clear();
        foreach (var p in aggProviders)
        {
            bool en = Str(p, "enabled") != "False";
            var keys = new List<string>();
            object kv;
            if (p.TryGetValue("apiKeys", out kv) && kv is object[]) foreach (var k in (object[])kv) if (k != null && k.ToString() != "") keys.Add(k.ToString());
            var it = new ListViewItem(Str(p, "name"));
            it.SubItems.Add(en ? "已接入" : "未接入");
            it.SubItems.Add(Str(p, "baseUrl"));
            it.SubItems.Add(keys.Count == 0 ? "—" : string.Join(" , ", keys.ToArray()));
            aggList.Items.Add(it);
        }
        aggList.EndUpdate();
        int inPool = 0;
        foreach (var p in aggProviders) if (Str(p, "enabled") != "False") inPool++;
        aggCount.Text = aggProviders.Count + " 家已配置 · " + inPool + " 家在池";
    }

    void LoadAgg()
    {
        SetAggMsg("加载中…", SubText);
        Run(delegate
        {
            string json = Program.Api("GET", "/console/api/aggregate", null);
            var ser = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var root = ser.DeserializeObject(json) as Dictionary<string, object>;
            var list = new List<Dictionary<string, object>>();
            object pv;
            if (root != null && root.TryGetValue("providers", out pv) && pv is object[])
                foreach (var o in (object[])pv) { var d = o as Dictionary<string, object>; if (d != null) list.Add(d); }
            object mv; int modelCount = 0;
            if (root != null && root.TryGetValue("models", out mv) && mv is object[]) modelCount = ((object[])mv).Length;
            object ev; bool lane = !(root != null && root.TryGetValue("enabled", out ev) && ev is bool && !(bool)ev);
            var presets = new List<Dictionary<string, object>>();
            object pvv;
            if (root != null && root.TryGetValue("presets", out pvv) && pvv is object[])
                foreach (var o in (object[])pvv) { var d = o as Dictionary<string, object>; if (d != null) presets.Add(d); }
            // 免费额度厂商排前（与 web 端一致）
            presets.Sort(delegate (Dictionary<string, object> a, Dictionary<string, object> b) { return (Str(b, "free") == "True" ? 1 : 0) - (Str(a, "free") == "True" ? 1 : 0); });
            BeginInvoke((MethodInvoker)delegate
            {
                aggProviders = list;
                aggLane = lane;
                aggLaneCheck.Checked = lane;
                RenderAggList();
                aggPresets = presets;
                fillingAggCombo = true;
                aggPresetCombo.Items.Clear();
                foreach (var p in presets)
                    aggPresetCombo.Items.Add((Str(p, "free") == "True" ? "★ " : "") + Str(p, "name") + "（" + Str(p, "id") + "）");
                fillingAggCombo = false;
                aggPresetCombo.SelectedIndex = -1;
                SetAggMsg(modelCount + " 个模型已接入选择器（agg:渠道/模型）", Accent);
            });
        });
    }

    void SaveAgg(string okText)
    {
        var arr = new List<object>();
        foreach (var p in aggProviders)
        {
            var d = new Dictionary<string, object>();
            d["name"] = Str(p, "name");
            d["baseUrl"] = Str(p, "baseUrl");
            var keys = new List<string>();
            object kv;
            if (p.TryGetValue("apiKeys", out kv) && kv is object[]) foreach (var k in (object[])kv) if (k != null && k.ToString() != "") keys.Add(k.ToString());
            d["apiKeys"] = keys;
            d["enabled"] = Str(p, "enabled") != "False";
            arr.Add(d);
        }
        var body = new Dictionary<string, object>();
        body["providers"] = arr;
        body["enabled"] = aggLane;
        string json = new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(body);
        Run(delegate { Program.Api("POST", "/console/api/aggregate", json); }, delegate { SetAggMsg(okText + " ✓", Accent); LoadModelsIfVisible(); });
    }

    void LoadModelsIfVisible()
    {
        // 聚合变化会影响模型页目录与选择器；模型页打开着就顺带刷新
        if (pages.ContainsKey("models") && pages["models"].Visible) LoadModels();
    }

    void SetAggSelectedEnabled(bool en)
    {
        if (aggList.SelectedItems.Count == 0) { SetAggMsg("先在列表里选中一个渠道", SubText); return; }
        var p = aggProviders[aggList.SelectedIndices[0]];
        p["enabled"] = en;
        RenderAggList();
        SaveAgg((en ? "已接入 " : "已摘出 ") + Str(p, "name"));
    }

    /** 扫码登录页（0.3.64，形态对齐 dsh-xdpool）：三张站点厂商卡 + 本机导入 + 设备授权登录。
     *  客户端不画二维码（省第三方依赖）：/login/start 拿到授权链接后直接开浏览器，3 秒轮询授权结果。 */
    Panel BuildLoginPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("扫码登录"));
        page.Controls.Add(PageSub("登一次，它们的免费模型就出现在同一个选择器里。灰卡 = 暂未接入的厂商目录。", 60));

        loginBanner.Location = new Point(32, 92);
        loginBanner.Size = new Size(900, 26);
        loginBanner.ForeColor = InkText;
        loginBanner.BackColor = CardBack;
        loginBanner.TextAlign = ContentAlignment.MiddleLeft;
        loginBanner.Padding = new Padding(8, 0, 0, 0);
        page.Controls.Add(loginBanner);

        loginConnected.Location = new Point(32, 128);
        loginConnected.Size = new Size(200, 22);
        loginConnected.ForeColor = Accent;
        loginConnected.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        page.Controls.Add(loginConnected);

        int y = 158;
        for (int i = 0; i < LoginSites.Length; i++)
        {
            string site = LoginSites[i];
            var card = new Panel { Location = new Point(32, y), Size = new Size(900, 104), BackColor = CardBack };
            var chip = new Label { Text = LoginNames[i].Substring(0, 2), Location = new Point(16, 14), Size = new Size(34, 34), ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter, BackColor = LoginColors[i] };
            var name = new Label { Text = LoginNames[i] + "（" + site + "）", Location = new Point(60, 14), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold) };
            var count = new Label { Text = "未添加", Location = new Point(740, 18), Size = new Size(144, 20), ForeColor = SubText, TextAlign = ContentAlignment.MiddleRight };
            var desc = new Label { Text = LoginDescs[i], Location = new Point(60, 44), Size = new Size(800, 30), ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 8.75F) };
            var add = new Button { Text = "＋ 添加账号", Location = new Point(60, 72), Size = new Size(120, 26), FlatStyle = FlatStyle.Flat, BackColor = Accent, ForeColor = Color.White, Cursor = Cursors.Hand, Font = new Font("Microsoft YaHei UI", 9F) };
            add.FlatAppearance.BorderSize = 0;
            add.Click += delegate { StartDeviceLogin(site); };
            card.Controls.Add(chip);
            card.Controls.Add(name);
            card.Controls.Add(count);
            card.Controls.Add(desc);
            card.Controls.Add(add);
            card.Paint += delegate (object s, PaintEventArgs e)
            {
                using (var pen = new Pen(BorderLine)) e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
            };
            page.Controls.Add(card);
            loginCountLabels[site] = count;
            loginAddButtons[site] = add;
            y += 116;
        }

        // dsh-xdpool 支持扫码登录的其它厂商目录：未接入置灰（0.3.65）
        for (int i = 0; i < PendingNames.Length; i++)
        {
            var card = new Panel { Location = new Point(32, y), Size = new Size(900, 104), BackColor = CardBack };
            var chip = new Label { Text = PendingNames[i].Substring(0, 2), Location = new Point(16, 14), Size = new Size(34, 34), ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter, BackColor = PendingColors[i] };
            var name = new Label { Text = PendingNames[i] + " · " + PendingVendors[i], Location = new Point(60, 14), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold) };
            var badge = new Label { Text = "未接入", Location = new Point(790, 18), Size = new Size(94, 20), ForeColor = SubText, TextAlign = ContentAlignment.MiddleRight };
            var desc = new Label { Text = PendingDescs[i], Location = new Point(60, 44), Size = new Size(800, 30), ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 8.75F) };
            var add = new Button { Text = "暂未接入", Location = new Point(60, 72), Size = new Size(120, 26), FlatStyle = FlatStyle.Flat, Enabled = false, Font = new Font("Microsoft YaHei UI", 9F) };
            card.Controls.Add(chip);
            card.Controls.Add(name);
            card.Controls.Add(badge);
            card.Controls.Add(desc);
            card.Controls.Add(add);
            card.Paint += delegate (object s, PaintEventArgs e)
            {
                using (var pen = new Pen(BorderLine)) e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
            };
            page.Controls.Add(card);
            y += 116;
        }

        var importBtn = PlainButton("⬇ 导入本机账号（免扫码）");
        importBtn.Location = new Point(32, y + 4);
        importBtn.AutoSize = true;
        importBtn.Click += delegate
        {
            string importMsg = "";
            Run(delegate
            {
                string outText = Program.Api("POST", "/console/api/local/import", "{}");
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                var d = ser.DeserializeObject(outText) as Dictionary<string, object>;
                importMsg = "导入完成 ✓ 新增 " + Int(d, "imported") + " · 更新 " + Int(d, "updated") + " · 跳过 " + Int(d, "skipped");
            }, delegate { SetLoginStatus(importMsg + "（详情见网页控制台）", Accent); });
        };
        var webBtn = PlainButton("在网页控制台扫码（显示二维码）");
        webBtn.Location = new Point(300, y + 4);
        webBtn.AutoSize = true;
        webBtn.Click += delegate { Program.OpenConsole("login"); };
        page.Controls.Add(importBtn);
        page.Controls.Add(webBtn);

        loginStatus.Location = new Point(32, y + 48);
        loginStatus.Size = new Size(900, 40);
        loginStatus.ForeColor = SubText;
        page.Controls.Add(loginStatus);

        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            loginBanner.Width = w;
            foreach (Control c in page.Controls)
            {
                var card = c as Panel;
                if (card == null || card.Height != 104) continue;
                card.Width = w;
                var count = card.Controls.Count >= 3 ? card.Controls[2] : null;
                if (count != null) count.Location = new Point(Math.Max(200, card.Width - 160), 18);
                var desc = card.Controls.Count >= 4 ? card.Controls[3] : null;
                if (desc != null) desc.Width = Math.Max(120, card.Width - 80);
            }
        };
        return page;
    }

    void SetLoginStatus(string text, Color color)
    {
        loginStatus.Text = text;
        loginStatus.ForeColor = color;
    }

    /** 登录入口分发：CodeArts 走华为云 OAuth（服务端起本地回调，浏览器授权）；其余走设备授权。 */
    void StartDeviceLogin(string site)
    {
        if (site == "codearts") { StartCodeArtsLogin(site); return; }
        StartDeviceLoginBase(site);
    }

    /** CodeArts OAuth 登录：POST /login/start（服务端返回 portal 授权 URL 并已在本地挂回调服务器）
     *  → 打开浏览器 → 每 2.5 秒轮询 /login/poll 到 done（服务端后台 promise 已把凭据写入号池）。 */
    void StartCodeArtsLogin(string site)
    {
        if (loginPolling) { SetLoginStatus("已有登录流程进行中——请先等它完成", Warn); return; }
        loginPolling = true;
        foreach (var b in loginAddButtons.Values) b.Enabled = false;
        SetLoginStatus("正在准备华为云授权（" + site + "）…", SubText);
        new Thread(delegate()
        {
            string doneMsg = null;
            bool ok = false;
            try
            {
                string outText = Program.Api("POST", "/console/api/login/start", "{\"site\":\"" + site + "\"}");
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                var d = ser.DeserializeObject(outText) as Dictionary<string, object>;
                string authUrl = d != null && d.ContainsKey("authUrl") ? Str(d, "authUrl") : "";
                if (authUrl == "") throw new Exception("响应里没有授权链接：" + (outText.Length > 140 ? outText.Substring(0, 140) : outText));
                try { Process.Start(authUrl); }
                catch { /* 打不开浏览器不挡流程 */ }
                BeginInvoke((MethodInvoker)delegate
                {
                    SetLoginStatus("已在浏览器打开华为云授权页——登录并点击授权后自动检测。若未弹出请手动访问：" + authUrl, Accent);
                });
                var deadline = DateTime.UtcNow.AddMinutes(4);
                var t0 = DateTime.UtcNow;
                while (DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(2500);
                    string poll;
                    try { poll = Program.Api("GET", "/console/api/login/poll?site=" + site, null); }
                    catch { continue; }
                    try
                    {
                        var pd = ser.DeserializeObject(poll) as Dictionary<string, object>;
                        if (pd == null) continue;
                        if (Str(pd, "done") == "True")
                        {
                            doneMsg = "✅ CodeArts 登录成功（该站点现有 " + Str(pd, "account_count") + " 个账号）";
                            ok = true;
                            break;
                        }
                        int wait = (int)(DateTime.UtcNow - t0).TotalSeconds;
                        string line = "等待授权完成…（" + wait + "s）";
                        BeginInvoke((MethodInvoker)delegate { SetLoginStatus(line, SubText); });
                    }
                    catch { /* 单次轮询失败继续等 */ }
                }
                if (!ok && doneMsg == null) doneMsg = "⌛ 等待超时（4 分钟）——请重试";
            }
            catch (Exception ex)
            {
                doneMsg = "发起登录失败：" + ex.Message;
            }
            BeginInvoke((MethodInvoker)delegate
            {
                loginPolling = false;
                foreach (var b in loginAddButtons.Values) b.Enabled = true;
                SetLoginStatus(doneMsg ?? "登录流程结束", ok ? Accent : Danger);
                if (ok) RefreshAll();
            });
        }).Start();
    }

    /** 设备授权登录：POST /login/start → 浏览器打开授权页 → 每 3 秒轮询 /login/poll，最长 10 分钟。 */
    void StartDeviceLoginBase(string site)
    {
        if (loginPolling) { SetLoginStatus("已有登录流程进行中——请先等它完成（或在网页控制台多账号并登）", Warn); return; }
        loginPolling = true;
        foreach (var b in loginAddButtons.Values) b.Enabled = false;
        SetLoginStatus("正在向上游申请授权（" + site + "）…", SubText);
        new Thread(delegate()
        {
            string doneMsg = null;
            bool ok = false;
            try
            {
                string outText = Program.Api("POST", "/console/api/login/start", "{\"site\":\"" + site + "\"}");
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                var d = ser.DeserializeObject(outText) as Dictionary<string, object>;
                string authUrl = d != null && d.ContainsKey("authUrl") ? Str(d, "authUrl") : "";
                if (authUrl == "") throw new Exception("响应里没有授权链接：" + (outText.Length > 140 ? outText.Substring(0, 140) : outText));
                try { Process.Start(authUrl); }
                catch { /* 打不开浏览器不挡流程：授权链接仍显示在状态行 */ }
                BeginInvoke((MethodInvoker)delegate
                {
                    SetLoginStatus("已在浏览器打开授权页——在手机/浏览器上确认登录；每 3 秒自动检测。若浏览器没打开，请手动访问：" + authUrl, Accent);
                });
                var deadline = DateTime.UtcNow.AddMinutes(10);
                var t0 = DateTime.UtcNow;
                while (DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(3000);
                    string poll;
                    try { poll = Program.Api("GET", "/console/api/login/poll?site=" + site, null); }
                    catch { continue; }
                    try
                    {
                        var pd = ser.DeserializeObject(poll) as Dictionary<string, object>;
                        if (pd == null) continue;
                        if (Str(pd, "done") == "True")
                        {
                            string who = Str(pd, "label") != "" ? Str(pd, "label") : (Str(pd, "nickname") != "" ? Str(pd, "nickname") : Str(pd, "account_id"));
                            doneMsg = "✅ 登录成功：" + who + "（" + site + " 现有 " + Str(pd, "account_count") + " 个账号）";
                            ok = true;
                            break;
                        }
                        int wait = (int)(DateTime.UtcNow - t0).TotalSeconds;
                        string msg = Str(pd, "msg");
                        if (msg.Length > 60) msg = msg.Substring(0, 60);
                        string line = "等待确认中（" + wait + "s）…" + (msg != "" ? " 上游：" + msg : "");
                        BeginInvoke((MethodInvoker)delegate { SetLoginStatus(line, SubText); });
                    }
                    catch { /* 单次轮询失败继续等 */ }
                }
                if (!ok && doneMsg == null) doneMsg = "⌛ 等待超时（10 分钟）——请重试，或在网页控制台用二维码扫码";
            }
            catch (Exception ex)
            {
                doneMsg = "发起登录失败：" + ex.Message;
            }
            BeginInvoke((MethodInvoker)delegate
            {
                loginPolling = false;
                foreach (var b in loginAddButtons.Values) b.Enabled = true;
                SetLoginStatus(doneMsg ?? "登录流程结束", ok ? Accent : Danger);
                if (ok) RefreshAll();
            });
        }).Start();
    }

    /** 数据看板页（0.3.64，形态对齐 dsh-xdpool）：真实调用口径的六张卡 + 最近调用列表。 */
    Panel BuildDashPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("数据看板"));
        page.Controls.Add(PageSub("这里每个数字，都是这个池子真实发出去的调用数出来的。", 60));

        var dashCards = new List<Panel>();
        dashCards.Add(AddDashCard(page, "Token 总量", dashTokens, dashTokensSub, 0));
        dashCards.Add(AddDashCard(page, "轮次", dashRounds, dashRoundsSub, 1));
        dashCards.Add(AddDashCard(page, "轮失败", dashFails, dashFailsSub, 2));
        dashCards.Add(AddDashCard(page, "速度", dashSpeed, dashSpeedSub, 3));
        dashCards.Add(AddDashCard(page, "缓存命中", dashCache, dashCacheSub, 4));
        dashCards.Add(AddDashCard(page, "换号救回", dashRecovered, dashRecoveredSub, 5));

        var clearBtn = PlainButton("清空调用记录");
        clearBtn.Location = new Point(32, 216);
        clearBtn.Click += delegate
        {
            Run(delegate { Program.Api("POST", "/console/api/dashboard/clear", "{}"); },
                delegate { dashStatus.Text = "已清空调用记录（内存环，不影响统计）✓"; dashStatus.ForeColor = Accent; });
        };
        var webBtn = PlainButton("打开网页控制台");
        webBtn.Location = new Point(160, 216);
        webBtn.Click += delegate { Program.OpenConsole("dash"); };
        page.Controls.Add(clearBtn);
        page.Controls.Add(webBtn);

        dashStatus.Location = new Point(32, 258);
        dashStatus.Size = new Size(880, 20);
        dashStatus.ForeColor = SubText;
        page.Controls.Add(dashStatus);

        var recentCaption = new Label { Text = "最近调用（新 → 旧）", Location = new Point(32, 284), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        dashRecent.Location = new Point(32, 310);
        dashRecent.Size = new Size(880, 220);
        dashRecent.View = View.Details;
        dashRecent.FullRowSelect = true;
        dashRecent.Columns.Add("时间", 110);
        dashRecent.Columns.Add("模型", 220);
        dashRecent.Columns.Add("模式", 100);
        dashRecent.Columns.Add("状态", 66);
        dashRecent.Columns.Add("耗时", 88);
        dashRecent.Columns.Add("速度", 88);
        dashRecent.Columns.Add("积分", 80);
        dashRecent.Columns.Add("账号", 140);
        dashRecent.Font = new Font("Microsoft YaHei UI", 9F);
        page.Controls.Add(recentCaption);
        page.Controls.Add(dashRecent);

        var note = new Label
        {
            Text = "轮次 = 客户端提问；上游调用包含换号/降级重试（一次提问可能变成几次调用）。最近调用保留在内存里（最多 50 条），重启会清空。",
            Location = new Point(32, 540), Size = new Size(880, 36), ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 8.75F),
        };
        page.Controls.Add(note);

        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            dashStatus.Width = w;
            dashRecent.Width = w;
            dashRecent.Height = Math.Max(120, page.ClientSize.Height - 400);
            note.Width = w;
            int sw = (w - 5 * 12) / 6;
            if (sw > 184) sw = 184;
            if (sw < 108) sw = 108;
            for (int i = 0; i < dashCards.Count; i++)
            {
                dashCards[i].Width = sw;
                dashCards[i].Location = new Point(32 + i * (sw + 12), 100);
            }
        };
        return page;
    }

    Panel AddDashCard(Panel page, string title, Label valueLabel, Label subLabel, int idx)
    {
        var card = new Panel { Location = new Point(32 + idx * 150, 100), Size = new Size(138, 100), BackColor = CardBack };
        var t = new Label { Text = title, Location = new Point(14, 12), ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 9F), AutoSize = true };
        valueLabel.Location = new Point(14, 34);
        valueLabel.Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold);
        valueLabel.ForeColor = InkText;
        valueLabel.Text = "—";
        valueLabel.AutoSize = true;
        subLabel.Location = new Point(14, 66);
        subLabel.Font = new Font("Microsoft YaHei UI", 7.75F);
        subLabel.ForeColor = SubText;
        subLabel.Text = "";
        subLabel.AutoEllipsis = true;
        card.Controls.Add(t);
        card.Controls.Add(valueLabel);
        card.Controls.Add(subLabel);
        card.Paint += delegate (object s, PaintEventArgs e)
        {
            using (var pen = new Pen(BorderLine)) e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
        };
        page.Controls.Add(card);
        return card;
    }

    Panel BuildUsagePage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("用量"));
        page.Controls.Add(PageSub("调用与积分消耗（本机统计口径，跟随上游实时刷新）。", 60));

        var statCards = new List<Panel>();
        statCards.Add(AddStatCard(page, "今日调用", usageTodayCalls, 32, 100));
        statCards.Add(AddStatCard(page, "今日积分", usageTodayCredit, 232, 100));
        statCards.Add(AddStatCard(page, "累计积分", usageTotalCredit, 432, 100));
        statCards.Add(AddStatCard(page, "今日换号救回", usageRecovered, 632, 100));

        var hoursCaption = new Label { Text = "今日 24 小时调用分布", Location = new Point(32, 216), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        hoursPanel.Location = new Point(32, 242);
        hoursPanel.Size = new Size(880, 160);
        hoursPanel.BackColor = CardBack;
        hoursPanel.Paint += HoursPaint;
        page.Controls.Add(hoursCaption);
        page.Controls.Add(hoursPanel);

        var topCaption = new Label { Text = "消耗 Top5 模型（累计）", Location = new Point(32, 416), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        topModels.Location = new Point(32, 442);
        topModels.Size = new Size(880, 150);
        topModels.View = View.Details;
        topModels.FullRowSelect = true;
        topModels.Columns.Add("模型", 300);
        topModels.Columns.Add("调用", 90);
        topModels.Columns.Add("积分", 110);
        topModels.Columns.Add("输出 tokens", 160);
        topModels.Font = new Font("Microsoft YaHei UI", 9F);
        page.Controls.Add(topCaption);
        page.Controls.Add(topModels);

        // 页级横滚硬禁 + 宽度随页面 Resize 显式铺排（统计四卡等距铺满）
        page.HorizontalScroll.Enabled = false;
        page.HorizontalScroll.Visible = false;
        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            hoursPanel.Width = w;
            topModels.Width = w;
            int sw = (w - 3 * 16) / 4;
            if (sw > 184) sw = 184;
            if (sw < 120) sw = 120;
            for (int i = 0; i < statCards.Count; i++)
            {
                statCards[i].Width = sw;
                statCards[i].Location = new Point(32 + i * (sw + 16), 100);
            }
        };
        return page;
    }

    Panel AddStatCard(Panel page, string title, Label valueLabel, int x, int y)
    {
        var card = new Panel { Location = new Point(x, y), Size = new Size(184, 96), BackColor = CardBack };
        var t = new Label { Text = title, Location = new Point(16, 16), ForeColor = SubText, Font = new Font("Microsoft YaHei UI", 9F), AutoSize = true };
        valueLabel.Location = new Point(16, 44);
        valueLabel.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
        valueLabel.ForeColor = InkText;
        valueLabel.Text = "—";
        valueLabel.AutoSize = true;
        card.Controls.Add(t);
        card.Controls.Add(valueLabel);
        card.Paint += delegate (object s, PaintEventArgs e)
        {
            using (var pen = new Pen(BorderLine)) e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
        };
        page.Controls.Add(card);
        return card;
    }

    void HoursPaint(object s, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(CardBack);
        var hours = todayHoursData as object[];
        if (hours == null || hours.Length == 0)
        {
            TextRenderer.DrawText(g, "今天还没有调用数据", new Font("Microsoft YaHei UI", 9F),
                new Rectangle(0, 0, hoursPanel.Width, hoursPanel.Height), SubText,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            return;
        }
        int x0 = 30, y0 = 12, chartH = hoursPanel.Height - 40, chartW = hoursPanel.Width - x0 - 16;
        double max = 1;
        var callsByHour = new double[24];
        for (int i = 0; i < 24 && i < hours.Length; i++)
        {
            var h = hours[i] as Dictionary<string, object>;
            if (h == null) continue;
            callsByHour[i] = Convert.ToDouble(h.ContainsKey("calls") ? h["calls"] : 0);
            if (callsByHour[i] > max) max = callsByHour[i];
        }
        int colW = chartW / 24;
        using (var pen = new Pen(BorderLine)) g.DrawLine(pen, x0, y0 + chartH, x0 + chartW, y0 + chartH);
        for (int i = 0; i < 24; i++)
        {
            int h2 = (int)Math.Round(callsByHour[i] / max * (chartH - 10));
            if (h2 > 0)
                using (var b = new SolidBrush(Accent))
                    g.FillRectangle(b, x0 + i * colW + 2, y0 + chartH - h2, colW - 3, h2);
            if (i % 4 == 0)
                TextRenderer.DrawText(g, i + "时", new Font("Microsoft YaHei UI", 7.5F),
                    new Rectangle(x0 + i * colW - 6, y0 + chartH + 4, colW + 12, 16), SubText,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.Top);
        }
        TextRenderer.DrawText(g, "峰值 " + max + " 次/时", new Font("Microsoft YaHei UI", 8F),
            new Point(x0 + chartW - 110, y0), SubText);
    }

    Panel BuildSettingsPage()
    {
        var page = new Panel { BackColor = BodyBack, Dock = DockStyle.Fill, AutoScroll = true };
        page.Controls.Add(PageTitle("设置"));
        page.Controls.Add(PageSub("调度策略 / 每日预算 / 自动任务 / 服务管控。", 60));

        var policyCaption = new Label { Text = "调度策略", Location = new Point(32, 100), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        policyCombo.Location = new Point(32, 128);
        policyCombo.Size = new Size(260, 26);
        policyCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        policyCombo.Items.AddRange(new object[] {
            "expiry-first — 到期优先（推荐）",
            "balance-first — 余额优先",
            "round-robin — 轮询均摊",
            "free-first — 免费优先",
            "sticky — 会话粘滞（保缓存）",
            "balanced — 均衡随机",
            "pinned — 固定账号",
        });
        policyCombo.SelectedIndex = 0;
        var applyPolicy = PlainButton("应用策略");
        applyPolicy.Location = new Point(306, 126);
        applyPolicy.Click += delegate
        {
            string[] ids = { "expiry-first", "balance-first", "round-robin", "free-first", "sticky", "balanced", "pinned" };
            string id = ids[policyCombo.SelectedIndex];
            Run(delegate { Program.Api("POST", "/console/api/policy", "{\"policy\":\"" + id + "\"}"); });
        };
        page.Controls.Add(policyCaption);
        page.Controls.Add(policyCombo);
        page.Controls.Add(applyPolicy);

        var budgetCaption = new Label { Text = "每日预算", Location = new Point(32, 178), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        budgetEnabledCheck.Text = "启用"; budgetEnabledCheck.Location = new Point(32, 204); budgetEnabledCheck.AutoSize = true;
        var dailyCap = new Label { Text = "每日上限", Location = new Point(110, 206), AutoSize = true };
        budgetDailyBox.Location = new Point(176, 202); budgetDailyBox.Size = new Size(70, 23);
        var warnCap = new Label { Text = "预警线 %", Location = new Point(258, 206), AutoSize = true };
        budgetWarnBox.Location = new Point(326, 202); budgetWarnBox.Size = new Size(60, 23);
        var modeCap = new Label { Text = "超限动作", Location = new Point(398, 206), AutoSize = true };
        budgetModeCombo.Location = new Point(464, 202); budgetModeCombo.Size = new Size(150, 26);
        budgetModeCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        budgetModeCombo.Items.AddRange(new object[] { "warn — 仅预警", "free — 改走免费模型", "pause — 暂停出请求" });
        budgetModeCombo.SelectedIndex = 0;
        var budgetSave = PlainButton("保存预算");
        budgetSave.Location = new Point(630, 200);
        budgetSave.Click += delegate
        {
            string mode = new[] { "warn", "free", "pause" }[budgetModeCombo.SelectedIndex];
            Run(delegate
            {
                Program.Api("POST", "/console/api/budget", "{\"enabled\":" + Bool(budgetEnabledCheck.Checked)
                    + ",\"dailyCredits\":" + ParseNum(budgetDailyBox.Text, 100)
                    + ",\"warnPercent\":" + ParseNum(budgetWarnBox.Text, 80)
                    + ",\"mode\":\"" + mode + "\"}");
            }, delegate { settingsDirty = false; cfgStatus.Text = "预算配置已保存（" + DateTime.Now.ToString("HH:mm:ss") + "）"; });
        };
        page.Controls.Add(budgetCaption);
        page.Controls.Add(budgetEnabledCheck);
        page.Controls.Add(dailyCap);
        page.Controls.Add(budgetDailyBox);
        page.Controls.Add(warnCap);
        page.Controls.Add(budgetWarnBox);
        page.Controls.Add(modeCap);
        page.Controls.Add(budgetModeCombo);
        page.Controls.Add(budgetSave);

        var taskCaption = new Label { Text = "自动任务", Location = new Point(32, 252), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        taskEnabledCheck.Text = "总开关"; taskEnabledCheck.Location = new Point(32, 278); taskEnabledCheck.AutoSize = true;
        checkinCheck.Text = "签到"; checkinCheck.Location = new Point(110, 278); checkinCheck.AutoSize = true;
        growthCheck.Text = "成长任务"; growthCheck.Location = new Point(180, 278); growthCheck.AutoSize = true;
        reportCheck.Text = "活跃上报"; reportCheck.Location = new Point(266, 278); reportCheck.AutoSize = true;
        var reportCap = new Label { Text = "上报时点", Location = new Point(352, 280), AutoSize = true };
        reportTimesBox.Location = new Point(418, 276); reportTimesBox.Size = new Size(120, 23);
        var checkinCap = new Label { Text = "签到时点", Location = new Point(550, 280), AutoSize = true };
        checkinTimesBox.Location = new Point(616, 276); checkinTimesBox.Size = new Size(120, 23);
        var taskSave = PlainButton("保存任务配置");
        taskSave.Location = new Point(32, 304);
        taskSave.Click += delegate
        {
            Run(delegate
            {
                Program.Api("POST", "/console/api/tasks/config", "{\"enabled\":" + Bool(taskEnabledCheck.Checked)
                    + ",\"checkin\":" + Bool(checkinCheck.Checked)
                    + ",\"growth\":" + Bool(growthCheck.Checked)
                    + ",\"report\":" + Bool(reportCheck.Checked)
                    + ",\"reportTimes\":\"" + J(reportTimesBox.Text)
                    + "\",\"checkinTimes\":\"" + J(checkinTimesBox.Text) + "\"}");
            }, delegate { settingsDirty = false; cfgStatus.Text = "任务配置已保存（" + DateTime.Now.ToString("HH:mm:ss") + "）"; });
        };
        page.Controls.Add(taskCaption);
        page.Controls.Add(taskEnabledCheck);
        page.Controls.Add(checkinCheck);
        page.Controls.Add(growthCheck);
        page.Controls.Add(reportCheck);
        page.Controls.Add(reportCap);
        page.Controls.Add(reportTimesBox);
        page.Controls.Add(checkinCap);
        page.Controls.Add(checkinTimesBox);
        // dirty 钩子：用户动过设置控件后，60s 轮询不再回填（保存成功才解除）
        EventHandler dirtyHook = delegate { if (!fillingSettings) settingsDirty = true; };
        budgetEnabledCheck.CheckedChanged += dirtyHook;
        budgetDailyBox.TextChanged += dirtyHook;
        budgetWarnBox.TextChanged += dirtyHook;
        budgetModeCombo.SelectedIndexChanged += dirtyHook;
        taskEnabledCheck.CheckedChanged += dirtyHook;
        checkinCheck.CheckedChanged += dirtyHook;
        growthCheck.CheckedChanged += dirtyHook;
        reportCheck.CheckedChanged += dirtyHook;
        reportTimesBox.TextChanged += dirtyHook;
        checkinTimesBox.TextChanged += dirtyHook;
        page.Controls.Add(taskSave);

        var svcCaption = new Label { Text = "服务管控", Location = new Point(32, 352), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        serviceStatus.Location = new Point(32, 380);
        serviceStatus.Size = new Size(700, 20);
        serviceStatus.ForeColor = SubText;
        var svcBtns = new FlowLayoutPanel { Location = new Point(32, 406), Size = new Size(860, 42) };
        // 服务启停走 Run（后台线程）：StartService 最多等 15s、RestartService 20s+，同步跑会把窗口冻死
        AddBtn(svcBtns, "启动服务", delegate { serviceStatus.Text = "启动中…"; Run(delegate { Program.RunBlocking(delegate { if (!Program.Health()) Program.StartService(); }); }); });
        AddBtn(svcBtns, "停止服务", delegate { serviceStatus.Text = "停止中…"; Run(delegate { Program.RunBlocking(delegate { if (Program.Health()) Program.StopService(); }); }); });
        AddBtn(svcBtns, "重启服务", delegate { serviceStatus.Text = "重启中…"; Run(delegate { Program.RunBlocking(Program.RestartService); }); });
        AddBtn(svcBtns, "检查更新", delegate { Program.CheckUpdateUi(); });
        AddBtn(svcBtns, "给智能体安装插件", delegate { new Thread(delegate() { Program.InstallPluginToZcode(); }).Start(); });
        page.Controls.Add(svcCaption);
        page.Controls.Add(serviceStatus);
        page.Controls.Add(svcBtns);

        var consoleCaption = new Label { Text = "更多", Location = new Point(32, 464), AutoSize = true, ForeColor = InkText, Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) };
        var consoleBtn = PlainButton("打开网页控制台（完整功能：账号详情/模型/用量明细/诊断）");
        consoleBtn.Location = new Point(32, 492);
        consoleBtn.Click += delegate { Program.OpenConsole(); };
        page.Controls.Add(consoleCaption);
        page.Controls.Add(consoleBtn);

        cfgStatus.Location = new Point(32, 534);
        cfgStatus.Size = new Size(700, 20);
        cfgStatus.ForeColor = SubText;
        page.Controls.Add(cfgStatus);

        // 页级横滚硬禁 + 状态行/按钮面板宽度随页面 Resize
        page.HorizontalScroll.Enabled = false;
        page.HorizontalScroll.Visible = false;
        page.Resize += delegate
        {
            int w = Math.Max(360, page.ClientSize.Width - 64);
            serviceStatus.Width = w;
            cfgStatus.Width = w;
            svcBtns.Width = w;
        };
        return page;
    }

    void ShowPage(string page)
    {
        foreach (var kv in pages) kv.Value.Visible = kv.Key == page;
        if (page == "models" && modelList != null && modelList.Items.Count == 0) LoadModels();
        if (page == "agg" && aggList != null && aggList.Items.Count == 0) LoadAgg();
        foreach (var nb in navButtons) nb.Selected = nb.Text == NavNameOf(page);
        foreach (var nb in navButtons) nb.Invalidate();
    }

    static string NavNameOf(string page)
    {
        if (page == "accounts") return "账号管理";
        if (page == "login") return "扫码登录";
        if (page == "tasks") return "任务中心";
        if (page == "models") return "模型";
        if (page == "agg") return "聚合渠道";
        if (page == "dash") return "数据看板";
        if (page == "usage") return "用量";
        return "设置";
    }

    /** 用缓存的最近数据重排账号卡（窗口缩放/刷新共用；宽度随容器实时自适应）。 */
    void RebuildCards()
    {
        accountCards.SuspendLayout();
        accountCards.Controls.Clear();
        visibleAccountKeys.Clear();
        var cardW = Math.Max(500, accountCards.ClientSize.Width - 26); // -26 预留纵滚条宽：出现/消失不再触发卡宽变化（防循环抖动出横滚）
        var alerts = new List<string>();
        string siteFilter = acctSiteCombo != null && acctSiteCombo.SelectedIndex > 0 ? Convert.ToString(acctSiteCombo.SelectedItem) : "";
        string q = acctSearchBox != null ? acctSearchBox.Text.Trim().ToLowerInvariant() : "";
        var view = new List<int>();
        for (int i = 0; i < lastRows.Count; i++)
        {
            string site = i < lastSiteLabels.Count ? lastSiteLabels[i][1] : "";
            string siteLabel = i < lastSiteLabels.Count ? lastSiteLabels[i][0] : "";
            var a = lastRows[i];
            if (siteFilter != "" && site != siteFilter) continue;
            if (q != "")
            {
                string hay = (Str(a, "label") + " " + Str(a, "uid") + " " + Str(a, "id") + " " + siteLabel).ToLowerInvariant();
                if (!hay.Contains(q)) continue;
            }
            view.Add(i);
        }
        int sortMode = acctSortCombo != null ? acctSortCombo.SelectedIndex : 0;
        if (sortMode > 0)
        {
            view.Sort(delegate (int i1, int i2)
            {
                var a1 = lastRows[i1];
                var a2 = lastRows[i2];
                if (sortMode == 1)
                {
                    DateTime? t1 = CreditExpTime(a1), t2 = CreditExpTime(a2);
                    if (t1 == null && t2 == null) return 0;
                    if (t1 == null) return 1;
                    if (t2 == null) return -1;
                    return t1.Value.CompareTo(t2.Value);
                }
                if (sortMode == 2) return RemainOf(a2).CompareTo(RemainOf(a1));
                bool bad1 = Status(a1).IndexOf("🟢") < 0;
                bool bad2 = Status(a2).IndexOf("🟢") < 0;
                if (bad1 == bad2) return 0;
                return bad1 ? -1 : 1;
            });
        }
        foreach (int i in view)
        {
            var a = lastRows[i];
            string siteLabel = i < lastSiteLabels.Count ? lastSiteLabels[i][0] : "";
            string site = i < lastSiteLabels.Count ? lastSiteLabels[i][1] : "cn-cli";
            visibleAccountKeys.Add(AcctKey(site, Str(a, "id")));
            var c = MakeAccountCard(a, siteLabel, site, currentPolicy, pinnedId);
            c.Width = cardW;
            accountCards.Controls.Add(c);
            CollectAlert(a, siteLabel, alerts);
        }
        accountEmpty.Visible = view.Count == 0;
        accountEmpty.Text = view.Count == 0 && lastRows.Count > 0
            ? "当前筛选没有匹配的账号"
            : "还没有账号——点「OAuth 扫码添加」或「导入本机账号」";
        if (alerts.Count > 0)
        {
            alertLabel.Visible = true;
            alertLabel.Text = "⚠ " + string.Join("　|　", alerts.Take(3).ToArray());
            alertLabel.BackColor = alerts[0].Contains("登录失效") ? Danger : Color.FromArgb(217, 119, 6);
        }
        else alertLabel.Visible = false;
        accountCards.ResumeLayout();
    }

    void RefreshAll()
    {
        if (busy) return;
        busy = true;
        new Thread(delegate()
        {
            bool up = Program.Health();
            string statusText = "";
            string serverVersion = "";
            List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
            List<string[]> siteLabels = new List<string[]>();
            var siteCounts = new Dictionary<string, int>();      // 扫码登录页：站点 → 账号数（0.3.64）
            string todayCalls = "—", todayCredit = "—", totalCredit = "—", todayRecovered = "0";
            string curPolicy = "", pinnedIdNow = "";
            string tasksJson = "", usageJson = "", dashJson = "";
            object gainedTotal = null, checkinDays = null, todayExecSource = null, gainedToday = null;
            List<Dictionary<string, object>> history = new List<Dictionary<string, object>>();
            object todayHours = null;
            List<Dictionary<string, object>> byModel = new List<Dictionary<string, object>>();
            Dictionary<string, object> bridgeTasks = null;
            Dictionary<string, object> bridgeBudget = null;
            Dictionary<string, object> dashToday = null;         // 数据看板（0.3.64）
            List<Dictionary<string, object>> dashRecentRows = new List<Dictionary<string, object>>();
            if (!up)
            {
                statusText = "服务未运行——设置页可「启动服务」，或重启本客户端自动拉起";
            }
            else
            {
                Dictionary<string, object> root = null;
                try
                {
                    string bridge = Program.Api("GET", "/console/api/bridge", null);
                    string policyJson = Program.Api("GET", "/console/api/policy", null);
                    var ser = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    root = ser.DeserializeObject(bridge) as Dictionary<string, object>;
                    serverVersion = root != null && root.ContainsKey("version") ? Str(root, "version") : "";
                    curPolicy = ExtractString(policyJson, "policy");
                    var pm = System.Text.RegularExpressions.Regex.Match(policyJson, "\"pinnedAccountId\"\\s*:\\s*\"([^\"]*)\"");
                    pinnedIdNow = pm.Success ? pm.Groups[1].Value : "";
                    var dm = root != null && root.ContainsKey("defaultModel") ? Str(root, "defaultModel") : "";
                    statusText = "运行中 · 端口 " + Program.Port + " · 策略 " + curPolicy + (dm != "" ? " · 当前使用模型 " + dm : "");
                    var sites = root != null && root.ContainsKey("sites") ? root["sites"] as object[] : null;
                    if (sites != null)
                    {
                        foreach (object so in sites)
                        {
                            var site = so as Dictionary<string, object>;
                            if (site == null) continue;
                            var siteKey = Str(site, "site");
                            var accounts = site.ContainsKey("accounts") ? site["accounts"] as object[] : null;
                            int acctN = 0;
                            if (accounts != null)
                            {
                                acctN = accounts.Length;
                                foreach (object ao in accounts)
                                {
                                    var a = ao as Dictionary<string, object>;
                                    if (a == null) continue;
                                    rows.Add(a);
                                    siteLabels.Add(new string[] { site.ContainsKey("label") ? Str(site, "label") : Str(site, "site"), siteKey });
                                }
                            }
                            if (siteKey != "") siteCounts[siteKey] = acctN;
                        }
                    }
                }
                catch (Exception ex) { statusText = "服务响应异常：" + ex.Message; }
                // 预算/任务配置直接取自 /bridge（tasks=完整 cfg.tasks + budget；/console/api/tasks/config 没有 GET 分支、
                // /budget 未启用时只有 enabled 一个字段，旧取法导致输入框永远空白）
                try
                {
                    bridgeTasks = root != null && root.ContainsKey("tasks") ? root["tasks"] as Dictionary<string, object> : null;
                    bridgeBudget = bridgeTasks != null && bridgeTasks.ContainsKey("budget") ? bridgeTasks["budget"] as Dictionary<string, object> : null;
                }
                catch { }
                try { tasksJson = Program.Api("GET", "/console/api/tasks", null); } catch { }
                try { usageJson = Program.Api("GET", "/console/api/usage", null); } catch { }
                try { dashJson = Program.Api("GET", "/console/api/dashboard", null); } catch { }

                var ser2 = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                try
                {
                    var t = ser2.DeserializeObject(tasksJson) as Dictionary<string, object>;
                    if (t != null)
                    {
                        todayExecSource = t;
                        gainedTotal = t.ContainsKey("gainedTotal") ? t["gainedTotal"] : null;
                        gainedToday = t.ContainsKey("gainedToday") ? t["gainedToday"] : null;
                        checkinDays = t.ContainsKey("checkinDays") ? t["checkinDays"] : null;
                        var hist = t.ContainsKey("history") ? t["history"] as object[] : null;
                        if (hist != null) foreach (object h in hist) { var d = h as Dictionary<string, object>; if (d != null) history.Add(d); }
                    }
                }
                catch { }
                try
                {
                    var dv = ser2.DeserializeObject(dashJson) as Dictionary<string, object>;
                    if (dv != null)
                    {
                        dashToday = dv.ContainsKey("today") ? dv["today"] as Dictionary<string, object> : null;
                        var rec = dv.ContainsKey("recent") ? dv["recent"] as object[] : null;
                        if (rec != null) foreach (object r in rec) { var d = r as Dictionary<string, object>; if (d != null) dashRecentRows.Add(d); }
                    }
                }
                catch { }
                try
                {
                    var u = ser2.DeserializeObject(usageJson) as Dictionary<string, object>;
                    if (u != null)
                    {
                        var today = u.ContainsKey("today") ? u["today"] as Dictionary<string, object> : null;
                        var totals = u.ContainsKey("totals") ? u["totals"] as Dictionary<string, object> : null;
                        if (today != null) { todayCalls = NumS(today, "calls"); todayCredit = NumS(today, "credit"); todayRecovered = NumS(today, "recovered"); }
                        if (totals != null) totalCredit = NumS(totals, "credit");
                        todayHours = u.ContainsKey("todayHours") ? u["todayHours"] : null;
                        var bm = u.ContainsKey("byModel") ? u["byModel"] as object[] : null;
                        if (bm != null) foreach (object m in bm) { var d = m as Dictionary<string, object>; if (d != null) byModel.Add(d); }
                    }
                }
                catch { }
            }
            var rowsSnapshot = rows;
            var siteLabelsSnapshot = siteLabels;
            currentPolicy = curPolicy;
            pinnedId = pinnedIdNow;
            BeginInvoke((MethodInvoker)delegate
            {
                busy = false;
                lastRows.Clear();
                lastSiteLabels.Clear();
                foreach (var a in rowsSnapshot) lastRows.Add(a);
                foreach (var sl in siteLabelsSnapshot) lastSiteLabels.Add(sl);
                // 版本与托盘摘要：插件升级后不用重启客户端也能看到新版本
                double totalRemain = 0;
                int enabledCount = 0;
                foreach (var a in rowsSnapshot)
                {
                    if (Str(a, "enabled") != "False") enabledCount++;
                    object rv0;
                    double rr;
                    if (a.TryGetValue("creditRemain", out rv0) && rv0 != null && double.TryParse(rv0.ToString(), out rr) && rr > 0) totalRemain += rr;
                }
                string verShow = string.IsNullOrEmpty(serverVersion) ? Program.pluginVersion : serverVersion;
                navVersion.Text = "v" + verShow + " · :" + Program.Port;
                // 站点筛选下拉：保留用户当前选择，只更新候选项
                if (acctSiteCombo != null)
                {
                    string keepSite = acctSiteCombo.SelectedIndex > 0 ? Convert.ToString(acctSiteCombo.SelectedItem) : "";
                    acctSiteCombo.Items.Clear();
                    acctSiteCombo.Items.Add("全部站点");
                    foreach (var sk in siteCounts.Keys) acctSiteCombo.Items.Add(sk);
                    int idxSel = 0;
                    if (keepSite != "")
                    {
                        int found = acctSiteCombo.Items.IndexOf(keepSite);
                        if (found >= 0) idxSel = found;
                    }
                    acctSiteCombo.SelectedIndex = idxSel;
                }
                string trayTip = "WorkBuddy 积分桥 v" + verShow + " · " + enabledCount + " 账号 · 余额 " + FormatCredit(totalRemain);
                if (trayTip.Length > 63) trayTip = trayTip.Substring(0, 60) + "…";
                if (Program.tray != null) Program.tray.Text = trayTip;
                if (DateTime.Now >= acctMsgUntil) acctStatus.Text = up ? ("状态：" + statusText) : statusText;
                serviceStatus.Text = "服务：" + (up ? "运行中（端口 " + Program.Port + "）" : "未运行");
                if (Program.tray != null) Program.tray.Icon = Program.MakeIcon(up);
                RebuildCards();


                var gained = gainedTotal as Dictionary<string, object>;
                if (gained != null)
                {
                    kpiCredit.Text = NumS(gained, "credit");
                    kpiCheckins.Text = NumS(gained, "checkins");
                    kpiClaims.Text = NumS(gained, "claims");
                    kpiTravels.Text = NumS(gained, "travels");
                    kpiStreaks.Text = NumS(gained, "streaks");
                }
                todayExec.Text = BuildTodayExec(todayExecSource);
                if (checkinDays is Dictionary<string, object>) checkinDaysData = (Dictionary<string, object>)checkinDays;
                calendarPanel.Invalidate();
                historyList.BeginUpdate();
                historyList.Items.Clear();
                int shown = 0;
                foreach (var h in history)
                {
                    if (shown >= 12) break;
                    DateTime at;
                    string when = DateTime.TryParse(Str(h, "at"), out at) ? at.ToString("MM-dd HH:mm") : "";
                    var it = new ListViewItem(when);
                    it.SubItems.Add((Str(h, "ok") == "True" ? "✓ " : "✗ ") + Str(h, "msg"));
                    historyList.Items.Add(it);
                    shown++;
                }
                historyList.EndUpdate();

                usageTodayCalls.Text = todayCalls;
                usageTodayCredit.Text = todayCredit;
                usageTotalCredit.Text = totalCredit;
                usageRecovered.Text = todayRecovered;
                todayHoursData = todayHours;
                hoursPanel.Invalidate();
                topModels.BeginUpdate();
                topModels.Items.Clear();
                byModel.Sort((x, y) => CreditOf(y).CompareTo(CreditOf(x)));
                int top = 0;
                foreach (var m in byModel)
                {
                    if (top >= 5) break;
                    var it = new ListViewItem(Str(m, "model") + "（" + Str(m, "site") + "）");
                    it.SubItems.Add(NumS(m, "calls"));
                    it.SubItems.Add(NumS(m, "credit"));
                    it.SubItems.Add(NumS(m, "completionTokens"));
                    topModels.Items.Add(it);
                    top++;
                }
                topModels.EndUpdate();

                // ---- 扫码登录页（0.3.64）：站点账号数 + 已连接徽章 + 自动领取横幅 ----
                int connectedN = 0;
                foreach (var kv in siteCounts) if (kv.Value > 0) connectedN++;
                loginConnected.Text = "已连接 " + connectedN + " 个站点";
                for (int i = 0; i < LoginSites.Length; i++)
                {
                    string siteKey = LoginSites[i];
                    Label cl;
                    if (loginCountLabels.TryGetValue(siteKey, out cl))
                    {
                        int n = siteCounts.ContainsKey(siteKey) ? siteCounts[siteKey] : 0;
                        cl.Text = n > 0 ? "已添加 " + n + " 个账号" : "未添加";
                        cl.ForeColor = n > 0 ? Accent : SubText;
                    }
                }
                bool tasksOn = bridgeTasks == null || Str(bridgeTasks, "enabled") != "False";
                var gToday = gainedToday as Dictionary<string, object>;
                string banner;
                if (!tasksOn)
                {
                    banner = "○ 自动任务总开关已关闭——每日积分不会自动领取（任务中心可打开）";
                }
                else
                {
                    var bits = new List<string>();
                    if (gToday != null)
                    {
                        int ck = Int(gToday, "checkins"), clN = Int(gToday, "claims"), tv = Int(gToday, "travels");
                        double cr = CreditOf(gToday);
                        if (ck > 0) bits.Add("签到 " + ck + " 个账号");
                        if (clN > 0) bits.Add("领奖 " + clN + " 次");
                        if (tv > 0) bits.Add("猫猫旅行 " + tv + " 次");
                        if (cr > 0) bits.Add("+" + cr.ToString("0.##") + " 积分");
                    }
                    banner = bits.Count > 0
                        ? "✓ 自动领取每日积分 · 今日：" + string.Join("，", bits.ToArray())
                        : "✓ 自动领取每日积分已开启 · 今日还没有执行记录（时点在任务中心设置，错过自动补跑）";
                }
                loginBanner.Text = banner;

                // ---- 数据看板页（0.3.64）：六卡 + 最近调用 ----
                if (dashToday != null)
                {
                    double promptT = ToD(dashToday, "promptTokens"), completionT = ToD(dashToday, "completionTokens");
                    bool reported = Str(dashToday, "tokensReported") == "True";
                    double callsN = ToD(dashToday, "calls");
                    // 大数以「万 token」展示（1380px 卡宽放不下 8 位完整数字，截断比换行更难读）
                    double tokens = ToD(dashToday, "tokens");
                    dashTokens.Text = reported
                        ? Wan(tokens)
                        : (callsN > 0 ? "未上报" : "—");
                    dashTokensSub.Text = reported
                        ? "输入 " + Wan(promptT) + " · 输出 " + Wan(completionT)
                        : (callsN > 0 ? "上游没发 usage 帧" : "还没有调用");
                    dashRounds.Text = ToD(dashToday, "rounds").ToString("#,0");
                    dashRoundsSub.Text = ToD(dashToday, "upstreamCalls").ToString("#,0") + " 次上游调用";
                    dashFails.Text = ToD(dashToday, "roundFailures").ToString("#,0");
                    dashFailsSub.Text = ToD(dashToday, "roundFailures") > 0 ? "有整轮失败，看事件或日志" : "没有整轮失败";
                    double msD = ToD(dashToday, "ms");
                    dashSpeed.Text = msD > 0 ? (completionT / (msD / 1000.0)).ToString("0.0") + " tok/s" : "—";
                    dashSpeedSub.Text = msD > 0 ? "今日平均输出速度" : "没有计时数据";
                    double hit = ToD(dashToday, "cacheHitTokens");
                    dashCache.Text = promptT > 0 ? (hit / promptT * 100.0).ToString("0") + "%" : "—";
                    dashCacheSub.Text = promptT > 0 ? "命中 " + hit.ToString("#,0") + " tokens" : "上游未区分缓存 tokens";
                    dashRecovered.Text = ToD(dashToday, "recovered").ToString("#,0");
                    dashRecoveredSub.Text = "前一账号失败、换号后成功";

                    dashRecent.BeginUpdate();
                    dashRecent.Items.Clear();
                    int shownDash = 0;
                    foreach (var r in dashRecentRows)
                    {
                        if (shownDash >= 30) break;
                        DateTime at;
                        string when = DateTime.TryParse(Str(r, "at"), out at) ? at.ToString("HH:mm:ss") : "";
                        var it = new ListViewItem(when);
                        it.SubItems.Add(Str(r, "model"));
                        it.SubItems.Add(Str(r, "mode"));
                        int status = (int)ToD(r, "status");
                        it.SubItems.Add(status.ToString());
                        double msR = ToD(r, "ms");
                        it.SubItems.Add(msR >= 1000 ? (msR / 1000.0).ToString("0.0") + " s" : msR.ToString("0") + " ms");
                        it.SubItems.Add(Str(r, "tok_s") != "" ? Str(r, "tok_s") + " tok/s" : "—");
                        object crObj;
                        it.SubItems.Add(r.TryGetValue("credit", out crObj) && crObj != null ? CreditOf(r).ToString("0.##") : "—");
                        it.SubItems.Add(Str(r, "account") != "" ? Str(r, "account") : "—");
                        bool bad = status >= 400 || Str(r, "anomaly") == "True";
                        if (bad) it.ForeColor = Danger;
                        dashRecent.Items.Add(it);
                        shownDash++;
                    }
                    dashRecent.EndUpdate();
                }

                SyncPolicyCombo(curPolicy);
                if (!settingsDirty)
                {
                    fillingSettings = true;
                    try
                    {
                        if (bridgeBudget != null)
                        {
                            // 默认不开启；数字框始终预填（字段缺失/为 0 时用服务端默认 100/80）
                            budgetEnabledCheck.Checked = Str(bridgeBudget, "enabled") == "True";
                            string dc = NumS(bridgeBudget, "dailyCredits"); if (dc == "0") dc = "100";
                            string wp = NumS(bridgeBudget, "warnPercent"); if (wp == "0") wp = "80";
                            if (!budgetDailyBox.Focused) budgetDailyBox.Text = dc;
                            if (!budgetWarnBox.Focused) budgetWarnBox.Text = wp;
                            string mode = Str(bridgeBudget, "mode");
                            budgetModeCombo.SelectedIndex = mode == "free" ? 1 : mode == "pause" ? 2 : 0;
                        }
                        if (bridgeTasks != null)
                        {
                            taskEnabledCheck.Checked = Str(bridgeTasks, "enabled") == "True";
                            checkinCheck.Checked = Str(bridgeTasks, "checkin") == "True";
                            growthCheck.Checked = Str(bridgeTasks, "growth") == "True";
                            reportCheck.Checked = Str(bridgeTasks, "report") == "True";
                            // 时点为空=未配置（服务端回退小时数组），输入框按服务端默认预填：上报 08:00、签到 09:00/21:00
                            if (!reportTimesBox.Focused) reportTimesBox.Text = TimesOf(bridgeTasks, "reportTimes", "08:00");
                            if (!checkinTimesBox.Focused) checkinTimesBox.Text = TimesOf(bridgeTasks, "checkinTimes", "09:00,21:00");
                            cfgStatus.Text = "任务配置已同步（" + DateTime.Now.ToString("HH:mm:ss") + "）";
                        }
                    }
                    finally { fillingSettings = false; }
                }
            });
        }).Start();
    }

    static void CollectAlert(Dictionary<string, object> a, string siteLabel, List<string> alerts)
    {
        string name = Str(a, "label");
        string le = Str(a, "lastError");
        if (le.Contains("401")) alerts.Add("登录失效：" + name + "（" + siteLabel + "）");
        if (Str(a, "exhausted") == "True") alerts.Add("额度耗尽：" + name);
        double remain = 0;
        if (a.ContainsKey("creditRemain") && a["creditRemain"] != null && double.TryParse(a["creditRemain"].ToString(), out remain) && remain <= 200)
            alerts.Add("余额不足：" + name + " 仅 " + remain);
        var detail = a.ContainsKey("creditDetail") ? a["creditDetail"] as object[] : null;
        if (detail != null)
        {
            foreach (object b in detail)
            {
                var d = b as Dictionary<string, object>;
                if (d == null) continue;
                double r;
                DateTime exp;
                if (d.ContainsKey("remain") && d.ContainsKey("expireAt")
                    && double.TryParse(d["remain"].ToString(), out r) && r > 500
                    && DateTime.TryParse(Str(d, "expireAtRaw"), out exp) && (exp - DateTime.Now).TotalDays <= 7)
                {
                    alerts.Add("7 天内到期：" + name + " 还有 " + r + " 积分（" + Str(d, "package") + "）");
                    break;
                }
            }
        }
    }

    static string BuildTodayExec(object todayExecSource)
    {
        var t = todayExecSource as Dictionary<string, object>;
        if (t == null) return "";
        var lines = new List<string>();
        foreach (var kind in new[] { "report", "checkin", "growth", "travel", "streak" })
        {
            var entries = t.ContainsKey(kind) ? t[kind] as Dictionary<string, object> : null;
            if (entries == null) continue;
            string kindName = kind == "report" ? "活跃上报" : kind == "checkin" ? "签到" : kind == "growth" ? "成长任务"
                : kind == "travel" ? "猫猫旅行" : "连登管家";
            foreach (var e in entries)
            {
                var entry = e.Value as Dictionary<string, object>;
                if (entry == null) continue;
                string date = Str(entry, "date");
                if (date != "" && date != DateTime.Today.ToString("yyyy-MM-dd")) continue;
                lines.Add(kindName + " · " + Str(entry, "msg"));
            }
        }
        return lines.Count > 0 ? string.Join("\n", lines.ToArray()) : "今天还没有执行记录——点上方按钮跑一轮";
    }

    static double CreditOf(Dictionary<string, object> m)
    {
        double d;
        return m != null && m.ContainsKey("credit") && double.TryParse(m["credit"].ToString(), out d) ? d : 0;
    }

    /** 数值字段兜底读取（数据看板 0.3.64）：缺失/非数字一律 0，绝不抛。 */
    static double ToD(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return 0;
        double v;
        return double.TryParse(d[key].ToString(), out v) ? v : 0;
    }

    /** 大数转中文单位：≥1 亿用「亿」，≥10 万用「万」，否则原样（Token 卡主/副标题共用）。 */
    static string Wan(double v)
    {
        if (v >= 100000000) return (v / 100000000.0).ToString("0.##") + " 亿";
        if (v >= 100000) return (v / 10000.0).ToString("0.##") + " 万";
        return v.ToString("#,0");
    }

    /** 批量操作与筛选共用的账号键：site + NUL + id（label 可重名，id 在站点内唯一）。 */
    static string AcctKey(string site, string id) { return site + "\u0000" + id; }
    static string[] SplitAcctKey(string key) { return key.Split('\u0000'); }

    /** 最早一批积分的到期时间；用于排序（无批次返回 null，排最后）。 */
    static DateTime? CreditExpTime(Dictionary<string, object> a)
    {
        object arrObj;
        var arr = a.TryGetValue("creditDetail", out arrObj) ? arrObj as object[] : null;
        DateTime? earliest = null;
        if (arr != null)
        {
            foreach (var o in arr)
            {
                var b = o as Dictionary<string, object>;
                if (b == null) continue;
                object ev;
                var t = b.TryGetValue("expireAt", out ev) ? EpochToTime(ev) : null;
                if (t != null && (earliest == null || t.Value < earliest.Value)) earliest = t;
            }
        }
        return earliest;
    }

    static double RemainOf(Dictionary<string, object> a)
    {
        object v;
        double n;
        return a.TryGetValue("creditRemain", out v) && v != null && double.TryParse(v.ToString(), out n) ? n : 0;
    }

    void BulkSetEnabled(bool en)
    {
        if (selectedAccounts.Count == 0) { SetAcctStatus("先勾选账号（卡片左侧复选框）", Warn); return; }
        var keys = new List<string>(selectedAccounts);
        RunAcctWithStatus(en ? "批量启用" : "批量禁用", delegate
        {
            int ok = 0, fail = 0;
            foreach (var k in keys)
            {
                var p = SplitAcctKey(k);
                if (p.Length < 2) continue;
                try
                {
                    Program.Api("POST", "/console/api/pool/account",
                        "{\"site\":\"" + J(p[0]) + "\",\"id\":\"" + J(p[1]) + "\",\"enabled\":" + Bool(en) + "}");
                    ok++;
                }
                catch { fail++; }
            }
            return (en ? "批量启用" : "批量禁用") + "完成 ✓ " + ok + " 个" + (fail > 0 ? "，失败 " + fail + " 个" : "");
        });
    }

    void BulkSetMin()
    {
        if (selectedAccounts.Count == 0) { SetAcctStatus("先勾选账号（卡片左侧复选框）", Warn); return; }
        string v = ShowInput("批量设置保留积分下限", "", "留空 = 清除；如 200。余额低于它的账号暂停派活");
        if (v == null) return;
        string trimmed = v.Trim();
        double minVal = 0;
        if (trimmed != "" && !double.TryParse(trimmed, out minVal))
        {
            MessageBox.Show("保留线必须是数字，如 200", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var keys = new List<string>(selectedAccounts);
        RunAcctWithStatus("批量设保留线", delegate
        {
            int ok = 0, fail = 0;
            foreach (var k in keys)
            {
                var p = SplitAcctKey(k);
                if (p.Length < 2) continue;
                try
                {
                    Program.Api("POST", "/console/api/pool/account",
                        "{\"site\":\"" + J(p[0]) + "\",\"id\":\"" + J(p[1]) + "\",\"minRemain\":" + (trimmed == "" ? "null" : minVal.ToString()) + "}");
                    ok++;
                }
                catch { fail++; }
            }
            return "批量设保留线完成 ✓ " + ok + " 个" + (fail > 0 ? "，失败 " + fail + " 个" : "");
        });
    }

    void BulkRemove()
    {
        if (selectedAccounts.Count == 0) { SetAcctStatus("先勾选账号（卡片左侧复选框）", Warn); return; }
        if (MessageBox.Show("确定删除选中的 " + selectedAccounts.Count + " 个账号？\n\n只删本机账号池记录，不影响上游账号；token 可重新导入/登录。",
            "批量删除", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        var keys = new List<string>(selectedAccounts);
        RunAcctWithStatus("批量删除", delegate
        {
            int ok = 0, fail = 0;
            foreach (var k in keys)
            {
                var p = SplitAcctKey(k);
                if (p.Length < 2) continue;
                try
                {
                    Program.Api("POST", "/console/api/pool/account/remove",
                        "{\"site\":\"" + J(p[0]) + "\",\"id\":\"" + J(p[1]) + "\"}");
                    ok++;
                }
                catch { fail++; }
            }
            return "批量删除完成 ✓ " + ok + " 个" + (fail > 0 ? "，失败 " + fail + " 个" : "");
        });
    }

    Control MakeAccountCard(Dictionary<string, object> a, string siteLabel, string site, string policy, string pinnedAccountId)
    {
        string id = Str(a, "id");
        string label = Str(a, "label");
        string remain = Rem(a);
        string expiry = Exp(a);
        string min = Min(a);
        string status = Status(a);
        string lastModel = Str(a, "lastModel");
        bool isPinnedHere = policy == "pinned" && pinnedAccountId == id;

        var card = new Panel { Size = new Size(700, 78), BackColor = CardBack, Margin = new Padding(0, 0, 0, 8) };
        card.Paint += delegate (object s2, PaintEventArgs e2)
        {
            using (var pen = new Pen(BorderLine)) e2.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
            // 左侧状态色条：眼睛不用逐行读文字，扫一眼颜色就知道哪张卡有问题
            using (var b = new SolidBrush(StatusColor(status))) e2.Graphics.FillRectangle(b, 0, 0, 3, card.Height);
        };

        string key = AcctKey(site, id);
        var sel = new CheckBox
        {
            Location = new Point(10, 30), Size = new Size(18, 18),
            Checked = selectedAccounts.Contains(key), Cursor = Cursors.Hand,
        };
        sel.CheckedChanged += delegate
        {
            if (sel.Checked) selectedAccounts.Add(key);
            else selectedAccounts.Remove(key);
        };
        card.Controls.Add(sel);

        var avatar = new Panel { Size = new Size(36, 36), Location = new Point(32, 15), BackColor = Accent };
        SetRound(avatar, 18);
        var initial = new Label
        {
            Text = label.Length > 0 ? label.Substring(0, 1) : "?",
            Font = new Font("Microsoft YaHei UI", 11.5F, FontStyle.Bold),
            ForeColor = Color.White, BackColor = Color.Transparent,
            Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
        };
        avatar.Controls.Add(initial);
        card.Controls.Add(avatar);

        var name = new Label
        {
            Text = label, Location = new Point(78, 8),
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold), ForeColor = InkText, AutoSize = true,
        };
        card.Controls.Add(name);

        var line1Parts = new List<string> { status, "剩 " + remain + " 积分", "积分至 " + CreditExp(a) };
        if (min != "") line1Parts.Add("🛡 保留线 ≥ " + min);
        var line1 = new Label
        {
            Text = string.Join(" · ", line1Parts.ToArray()),
            Location = new Point(78, 31),
            Font = new Font("Microsoft YaHei UI", 8.5F),
            ForeColor = status.Contains("🔴") ? Danger : SubText,
        };
        // 按钮在右侧 y=27..51，line1 与按钮同行：宽度留出按钮区，超宽省略号
        line1.AutoEllipsis = true;
        line1.AutoSize = false;
        line1.Width = 700 - 290;
        card.Controls.Add(line1);

        // 站点短名：去掉「（域名）」括注，完整域名进 tooltip
        string fullSite = siteLabel;
        int paren = fullSite.IndexOf('（');
        string shortSite = paren > 0 ? fullSite.Substring(0, paren) : fullSite;
        string fullUid = Str(a, "uid");
        string uidShow = fullUid.Length > 12 ? fullUid.Substring(0, 12) + "…" : fullUid;
        var metaParts = new List<string> { "uid " + uidShow, shortSite };
        // 令牌到期与积分到期是两件事：旧版把 expiresAt 当「最早到期」显示，容易误判。
        if (Str(a, "expiresAt") != "") metaParts.Add("令牌至 " + expiry);
        if (lastModel != "") metaParts.Add("上次模型 " + lastModel);
        var meta = new Label
        {
            Text = string.Join(" · ", metaParts.ToArray()),
            Location = new Point(78, 54),
            Font = new Font("Microsoft YaHei UI", 8F), ForeColor = SubText,
        };
        // meta 在按钮下方（按钮底 51 < meta 顶 54），可占卡内全宽；超宽才省略号兜底
        meta.AutoEllipsis = true;
        meta.AutoSize = false;
        meta.Width = 700 - 90;
        string tipText = "uid " + fullUid + "\n" + fullSite + (lastModel != "" ? "\n上次模型 " + lastModel : "");
        cardTips.SetToolTip(meta, tipText);
        cardTips.SetToolTip(name, label + "（uid " + fullUid + "）");
        card.Controls.Add(meta);

        // 右侧操作按钮：卡 Resize 时按当前宽度重定位（不用 Anchor——Dock Top 面板宽度动态，显式重定位最稳）
        var testBtn = new Button
        {
            Text = "测连通", Size = new Size(62, 24), Location = new Point(434, 27), Anchor = AnchorStyles.Top | AnchorStyles.Right,
            FlatStyle = FlatStyle.Flat, BackColor = CardBack, ForeColor = InkText,
            Font = new Font("Microsoft YaHei UI", 8F), Cursor = Cursors.Hand,
        };
        testBtn.FlatAppearance.BorderColor = BorderLine;
        cardTips.SetToolTip(testBtn, "发一次 1 token 的极小请求，验证这个账号当前是否可用（消耗极少量积分）");
        var pinBtn = new Button
        {
            Text = isPinnedHere ? "解固定" : "固定使用", Size = new Size(62, 24), Location = new Point(500, 27), Anchor = AnchorStyles.Top | AnchorStyles.Right,
            FlatStyle = FlatStyle.Flat, BackColor = CardBack, ForeColor = InkText,
            Font = new Font("Microsoft YaHei UI", 8F), Cursor = Cursors.Hand,
        };
        pinBtn.FlatAppearance.BorderColor = BorderLine;
        var minBtn = new Button
        {
            Text = min != "" ? "改保留线" : "设保留线", Size = new Size(62, 24), Location = new Point(566, 27), Anchor = AnchorStyles.Top | AnchorStyles.Right,
            FlatStyle = FlatStyle.Flat, BackColor = CardBack, ForeColor = Accent,
            Font = new Font("Microsoft YaHei UI", 8F), Cursor = Cursors.Hand,
        };
        minBtn.FlatAppearance.BorderColor = Accent;
        testBtn.Click += delegate
        {
            SetAcctStatus("测连通：" + label + " …（1 token 请求）", InkText);
            bool started = Run(delegate
            {
                string json = Program.Api("POST", "/console/api/account/test",
                    "{\"site\":\"" + J(site) + "\",\"id\":\"" + J(id) + "\"}");
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                var d = ser.DeserializeObject(json) as Dictionary<string, object>;
                bool ok = d != null && d.ContainsKey("ok") && d["ok"] is bool && (bool)d["ok"];
                string ms = d != null && d.ContainsKey("ms") ? Convert.ToString(d["ms"]) : "?";
                string err = d != null && d.ContainsKey("error") ? Convert.ToString(d["error"]) : "";
                BeginInvoke((MethodInvoker)delegate
                {
                    SetAcctStatus(ok
                        ? "测连通 ✓ " + label + " · " + ms + " ms"
                        : "测连通 ✗ " + label + " · " + (err == "" ? "失败" : err), ok ? Accent : Danger);
                });
            });
            if (!started) SetAcctStatus("有操作正在进行，稍后再测", Warn);
        };
        pinBtn.Click += delegate
        {
            Run(delegate
            {
                Program.Api("POST", "/console/api/policy", isPinnedHere
                    ? "{\"policy\":\"expiry-first\"}"
                    : "{\"policy\":\"pinned\",\"pinnedAccountId\":\"" + J(id) + "\"}");
            });
        };
        minBtn.Click += delegate
        {
            string v = ShowInput("保留积分下限（余额低于它不派活）", min, "如 200；留空清除");
            if (v == null) return;
            string trimmed = v.Trim();
            double minVal = 0;
            if (trimmed != "" && !double.TryParse(trimmed, out minVal))
            {
                MessageBox.Show("保留线必须是数字，如 200", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Run(delegate
            {
                Program.Api("POST", "/console/api/pool/account", "{\"site\":\"" + J(site) + "\",\"id\":\"" + J(id) + "\",\"minRemain\":" + (trimmed == "" ? "null" : minVal.ToString()) + "}");
            });
        };
        card.Controls.Add(testBtn);
        card.Controls.Add(pinBtn);
        card.Controls.Add(minBtn);
        card.Resize += delegate
        {
            testBtn.Location = new Point(card.Width - 202, 27);
            pinBtn.Location = new Point(card.Width - 136, 27);
            minBtn.Location = new Point(card.Width - 70, 27);
            meta.Width = Math.Max(180, card.Width - 90);
            line1.Width = Math.Max(180, card.Width - 290);
        };
        return card;
    }    static string Bool(bool b) { return b ? "true" : "false"; }

    void SyncPolicyCombo(string policy)
    {
        string[] ids = { "expiry-first", "balance-first", "round-robin", "free-first", "sticky", "balanced", "pinned" };
        for (int i = 0; i < ids.Length; i++) if (ids[i] == policy) { policyCombo.SelectedIndex = i; return; }
    }

    static string ShowInput(string title, string initial, string placeholder)
    {
        var form = new Form
        {
            Text = title, FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(360, 110),
            MaximizeBox = false, MinimizeBox = false,
        };
        var box = new TextBox { Location = new Point(14, 30), Width = 330, Text = initial ?? "" };
        var ok = new Button { Text = "保存", DialogResult = DialogResult.OK, Location = new Point(180, 66), Size = new Size(76, 26) };
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(264, 66), Size = new Size(76, 26) };
        var hint = new Label { Text = placeholder, Location = new Point(14, 8), AutoSize = true, ForeColor = SubText };
        form.Controls.Add(box); form.Controls.Add(ok); form.Controls.Add(cancel); form.Controls.Add(hint);
        form.AcceptButton = ok; form.CancelButton = cancel;
        return form.ShowDialog() == DialogResult.OK ? box.Text : null;
    }

    /** 后台动作统一出口：actionBusy 防重入；完成（或失败弹框、RefreshAll）后在 UI 线程执行 after。
        返回 false = 当时正忙被跳过（调用方据此给提示或排队重试）。 */
    bool Run(Action act, Action after = null)
    {
        if (actionBusy) return false;
        actionBusy = true;
        new Thread(delegate()
        {
            string error = null;
            try { act(); }
            catch (Exception ex) { error = ex.Message; }
            BeginInvoke((MethodInvoker)delegate
            {
                actionBusy = false;
                if (error != null) MessageBox.Show(error, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                RefreshAll();
                if (after != null) after();
                // 模型页重载若在忙碌期被吞（切页/点刷新撞上长任务），这里补跑
                if (modelsReloadQueued)
                {
                    modelsReloadQueued = false;
                    LoadModels();
                }
            });
        }).Start();
        return true;
    }

    void SetTaskStatus(string text, Color c)
    {
        if (taskRunStatus == null) return;
        BeginInvoke((MethodInvoker)delegate { taskRunStatus.Text = text; taskRunStatus.ForeColor = c; });
    }

    /** 带状态行反馈的动作（0.3.59）：执行中/完成/失败都在任务页标题右侧可见——
        旧版点按钮毫无反馈，加上 60s 轮询与按钮共用互斥标志，轮询期间点击被静默吞掉。 */
    void RunWithStatus(string label, Action act)
    {
        SetTaskStatus(label + " 执行中…（上游任务可能要几十秒，完成后「最近记录」会更新）", InkText);
        Run(delegate
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try { act(); }
            catch (Exception ex)
            {
                SetTaskStatus(label + " 失败：" + ex.Message, Danger);
                throw; // Run 接住后弹错误框
            }
            sw.Stop();
            SetTaskStatus(label + " 完成 ✓（耗时 " + ((int)sw.Elapsed.TotalSeconds) + " 秒，明细见「最近记录」）", Accent);
        });
    }

    /** 账号页动作反馈（0.3.60）：导入/刷新积分的成功失败都落在按钮下方的状态行；
        15 秒内轮询不得回写，避免刚出的结果被 60s 轮询的「状态：…」糊掉。 */
    void SetAcctStatus(string text, Color c)
    {
        acctMsgUntil = DateTime.Now.AddSeconds(15);
        BeginInvoke((MethodInvoker)delegate { acctStatus.Text = text; acctStatus.ForeColor = c; });
    }

    void RunAcctWithStatus(string label, Func<string> act)
    {
        SetAcctStatus(label + " 执行中…", InkText);
        Run(delegate
        {
            string summary;
            try { summary = act(); }
            catch (Exception ex)
            {
                SetAcctStatus(label + " 失败：" + ex.Message, Danger);
                throw; // Run 接住后弹错误框
            }
            SetAcctStatus(summary, Accent);
        });
    }

    static int Int(Dictionary<string, object> d, string key)
    {
        object v;
        if (d != null && d.TryGetValue(key, out v) && v != null)
        {
            int n;
            if (v is int) return (int)v;
            if (int.TryParse(v.ToString(), out n)) return n;
        }
        return 0;
    }

    void RunTask(string kind)
    {
        string kindName = kind == "report" ? "活跃上报" : kind == "checkin" ? "签到" : kind == "growth" ? "成长任务" : kind == "travel" ? "猫猫旅行" : "连登管家";
        RunWithStatus(kindName, delegate { Program.Api("POST", "/console/api/tasks/run", "{\"kind\":\"" + kind + "\"}"); });
    }

    void RunPlayAll()
    {
        RunWithStatus("一键代打", delegate
        {
            string outText = Program.Api("POST", "/console/api/task-center/play-all", "{}");
            string msg = ExtractString(outText, "text");
            BeginInvoke((MethodInvoker)delegate
            {
                MessageBox.Show(string.IsNullOrEmpty(msg) ? "一键代打完成" : msg.Replace("\\n", "\n"), Program.AppName,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            });
        });
    }

    static string J(string s)
    {
        // JSON 字符串转义：只处理引号会把换行/反斜杠漏进请求体，服务端 400
        var sb = new System.Text.StringBuilder();
        foreach (char c in s ?? "")
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static double ParseNum(string s, double fallback)
    {
        double n;
        return double.TryParse((s ?? "").Trim(), out n) && n > 0 ? n : fallback;
    }

    static string ExtractString(string json, string key)
    {
        var m = System.Text.RegularExpressions.Regex.Match(json, "\\\\?\"" + key + "\\\\?\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        return m.Success ? m.Groups[1].Value.Replace("\\n", "\n").Replace("\\\"", "\"") : "";
    }

    static string Str(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key)) return "";
        var v = d[key];
        return v == null ? "" : v.ToString();
    }

    // /bridge 的时点字段是 JSON 数组（["08:00"]）——拼成 "08:00" 串；空数组/缺失按服务端默认预填
    static string TimesOf(Dictionary<string, object> d, string key, string def)
    {
        if (d == null || !d.ContainsKey(key)) return def;
        var arr = d[key] as object[];
        if (arr == null || arr.Length == 0) return def;
        var parts = new List<string>();
        foreach (var v in arr) if (v != null && v.ToString() != "") parts.Add(v.ToString());
        return parts.Count == 0 ? def : string.Join(",", parts.ToArray());
    }

    static string Rem(Dictionary<string, object> a)
    {
        var v = a.ContainsKey("creditRemain") ? a["creditRemain"] : null;
        if (v == null) return "—";
        double n;
        return double.TryParse(v.ToString(), out n) ? FormatCredit(n) : v.ToString();
    }

    /** 积分/余额展示：≥1 万用「万」，其余千分位，最多 2 位小数。 */
    static string FormatCredit(double n)
    {
        if (Math.Abs(n) >= 10000) return (n / 10000.0).ToString("0.##") + " 万";
        return n.ToString("#,##0.##");
    }

    /** 最早一批积分的到期时间（creditDetail[].expireAt）。旧版这里误用了 token 的 expiresAt。 */
    static string CreditExp(Dictionary<string, object> a)
    {
        object arrObj;
        var arr = a.TryGetValue("creditDetail", out arrObj) ? arrObj as object[] : null;
        DateTime? earliest = null;
        if (arr != null)
        {
            foreach (var o in arr)
            {
                var b = o as Dictionary<string, object>;
                if (b == null) continue;
                object ev;
                var t = b.TryGetValue("expireAt", out ev) ? EpochToTime(ev) : null;
                if (t == null) continue;
                if (earliest == null || t.Value < earliest.Value) earliest = t;
            }
        }
        if (earliest == null) return "—";
        int days = (int)Math.Ceiling((earliest.Value - DateTime.Now).TotalDays);
        string when = earliest.Value.ToString("MM-dd");
        if (days < 0) return when + "（已过期）";
        return when + "（" + days + " 天）";
    }

    /** 卡片左侧状态色条：故障红、冷却/保留线/禁用橙、正常绿。 */
    static Color StatusColor(string status)
    {
        if (status.Contains("🔴") || status.Contains("额度耗尽")) return Danger;
        if (status.Contains("冷却") || status.Contains("保留线") || status.Contains("已禁用")) return Warn;
        return Accent;
    }

    static DateTime? EpochToTime(object v)
    {
        if (v == null) return null;
        double n;
        try { n = Convert.ToDouble(v); } catch { return null; }
        if (n <= 0) return null;
        if (n < 1e12) n = n * 1000;
        return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(n).ToLocalTime();
    }

    static string Exp(Dictionary<string, object> a)
    {
        var t = EpochToTime(a.ContainsKey("expiresAt") ? a["expiresAt"] : null);
        if (t == null) return "—";
        int days = (int)Math.Ceiling((t.Value - DateTime.Now).TotalDays);
        string when = t.Value.ToString("MM-dd");
        if (days < 0) return when + "（已过期）";
        return when + "（" + days + " 天）";
    }

    static string Min(Dictionary<string, object> a)
    {
        var v = a.ContainsKey("minRemain") ? a["minRemain"] : null;
        if (v == null) return "";
        try { int n = Convert.ToInt32(v); return n > 0 ? n.ToString() : ""; } catch { return ""; }
    }

    static string Status(Dictionary<string, object> a)
    {
        if (Str(a, "enabled") == "False") return "已禁用";
        string le = Str(a, "lastError");
        if (le.Contains("401")) return "🔴 登录失效";
        var exh = EpochToTime(a.ContainsKey("exhaustedAt") ? a["exhaustedAt"] : null);
        if (exh != null && (DateTime.Now - exh.Value).TotalHours < 6) return "额度耗尽";
        var cd = EpochToTime(a.ContainsKey("cooldownUntil") ? a["cooldownUntil"] : null);
        if (cd != null && cd.Value > DateTime.Now) return "冷却中 · 至 " + cd.Value.ToString("HH:mm") + " 恢复";
        double remain = 0;
        bool hasRemain = a.ContainsKey("creditRemain") && a["creditRemain"] != null && double.TryParse(a["creditRemain"].ToString(), out remain);
        double min = 0;
        bool hasMin = a.ContainsKey("minRemain") && a["minRemain"] != null && double.TryParse(a["minRemain"].ToString(), out min);
        if (hasMin && min > 0 && hasRemain && remain < min) return "🛡 保留线内";
        if (hasRemain && remain <= 0) return "额度耗尽";
        return "🟢 可用";
    }

    static string NumS(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key)) return "0";
        try { return Convert.ToInt32(d[key]).ToString(); } catch { return "0"; }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            SaveWindowState();
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
        if (tray != null) tray.Visible = false;
    }
}
