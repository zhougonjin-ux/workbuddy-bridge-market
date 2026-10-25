// WorkBuddy 积分桥 · 安装/卸载向导（0.3.45）
//
// 双模式：默认 = 安装向导；`--uninstall` = 卸载（控制面板「应用和功能」的
// UninstallString 也指向本 exe 加该参数）。
//
// 安装动作：把托盘客户端（同目录 WorkBuddyBridgeTray.exe）装到
//   %LOCALAPPDATA%\WorkBuddyBridge，写 bridge-path.txt 记录服务目录
//   （自动探测 ZCode 插件缓存里版本最高的 server），建开始菜单/桌面快捷
//   方式，注册 HKCU Uninstall 键（控制面板可卸载），可选开机自启。
//
// 用系统自带 .NET Framework csc 编译（build.cmd），语言版本锁定 C# 5。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

static class SetupProgram
{
    const string AppName = "WorkBuddy 积分桥";
    const string RegUninstall = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddyBridge";
    const string RegRun = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const string ExeName = "WorkBuddyBridgeTray.exe";

    static string version = "0.3.45";
    static string sourceDir;   // Setup.exe 所在目录（托盘 exe 的来源）
    static string serverDir;   // 探测到的服务目录
    static string installDir;  // 目标安装目录
    static TextBox dirBox;
    static CheckBox deskCheck;
    static CheckBox autoRunCheck;
    static Button goButton;
    static Label logLabel;
    static Panel pagePanel;

    [STAThread]
    static void Main(string[] args)
    {
        bool uninstall = Array.IndexOf(args, "--uninstall") >= 0;
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        if (uninstall) { RunUninstall(); return; }
        Application.EnableVisualStyles();
        sourceDir = AppDomain.CurrentDomain.BaseDirectory;
        version = ReadOwnVersion();
        serverDir = DetectServerDir();
        if (silent)
        {
            // 静默安装（agent/测试自动化）：默认目录、桌面快捷方式、不写开机自启，全程无窗。
            // 结果用退出码表达：0=成功，1=失败。
            try
            {
                if (serverDir == null) throw new Exception("没有找到服务目录");
                installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkBuddyBridge");
                InstallCore(false);
                Environment.Exit(0);
            }
            catch { Environment.Exit(1); }
            return;
        }
        if (serverDir == null)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "没有自动找到服务目录——请选择插件里的 server 目录（含 server.mjs）";
                if (dlg.ShowDialog() != DialogResult.OK || !File.Exists(Path.Combine(dlg.SelectedPath, "server.mjs")))
                {
                    MessageBox.Show("未选择有效的 server 目录，安装取消。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                serverDir = dlg.SelectedPath;
            }
        }
        Application.Run(new WizardForm());
    }

    static string ReadOwnVersion()
    {
        try
        {
            string marker = Path.Combine(sourceDir, "version.txt");
            if (File.Exists(marker)) return File.ReadAllText(marker).Trim();
        }
        catch { }
        return "0.3.45";
    }

    /** 服务目录探测：ZCode 插件缓存里内容版本最高的 server → 本包便携结构 ../server → null（向导里手选）。
     *  ⚠️ 必须读 server/package.json 的实际版本比较——缓存目录名（如 0.3.3）与内容版本可以完全不同：
     *  运行目录 0.3.3 的内容往往比目录名更高的其他候选新得多（目录名只是首次安装时的市场版本）。 */
    static string DetectServerDir()
    {
        string best = null;
        Version bestV = null;
        try
        {
            string base0 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".zcode", "cli", "plugins", "cache", "dev-workbuddy-bridge-local", "workbuddy-bridge");
            if (Directory.Exists(base0))
            {
                foreach (string dir in Directory.GetDirectories(base0))
                {
                    string server = Path.Combine(dir, "server");
                    if (!File.Exists(Path.Combine(server, "server.mjs"))) continue;
                    Version v = ReadServerVersion(server) ?? new Version(0, 0, 0);
                    if (bestV == null || v > bestV) { bestV = v; best = server; }
                }
            }
        }
        catch { }
        if (best == null)
        {
            try
            {
                string portable = Path.GetFullPath(Path.Combine(sourceDir, "..", "server"));
                if (File.Exists(Path.Combine(portable, "server.mjs"))) best = portable;
            }
            catch { }
        }
        return best;
    }

    static Version ReadServerVersion(string serverDir)
    {
        try
        {
            string json = File.ReadAllText(Path.Combine(serverDir, "package.json"));
            var m = System.Text.RegularExpressions.Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]+)\"");
            Version v;
            if (m.Success && Version.TryParse(m.Groups[1].Value, out v)) return v;
        }
        catch { }
        return null;
    }

    /* ---------------- 安装向导窗体 ---------------- */

    class WizardForm : Form
    {
        public WizardForm()
        {
            Text = AppName + " 安装向导（v" + version + "）";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 300);

            var head = new Label
            {
                Text = "把 WorkBuddy 积分桥安装到这台电脑：\n开始菜单 / 桌面快捷方式、控制面板可卸载、托盘常驻 + 服务自启。",
                Location = new Point(16, 14), Size = new Size(528, 44)
            };
            var dirCaption = new Label
            {
                Text = "安装位置：",
                Location = new Point(16, 68), Size = new Size(520, 18)
            };
            dirBox = new TextBox
            {
                Location = new Point(16, 88), Size = new Size(440, 23),
                Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkBuddyBridge")
            };
            var browse = new Button
            {
                Text = "浏览…", Location = new Point(462, 87), Size = new Size(82, 25)
            };
            browse.Click += delegate
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选择安装目录（将自动创建）";
                    if (dlg.ShowDialog() == DialogResult.OK) dirBox.Text = dlg.SelectedPath;
                }
            };
            deskCheck = new CheckBox
            {
                Text = "创建桌面快捷方式", Location = new Point(16, 126), Size = new Size(240, 22), Checked = true
            };
            autoRunCheck = new CheckBox
            {
                Text = "开机自启（登录后托盘常驻，随时可用）", Location = new Point(16, 150), Size = new Size(360, 22), Checked = false
            };
            var svcLabel = new Label
            {
                Text = "服务目录（自动探测，供客户端拉起本地代理）：\n" + serverDir,
                Location = new Point(16, 184), Size = new Size(528, 40),
                ForeColor = Color.DimGray
            };
            logLabel = new Label
            {
                Text = "", Location = new Point(16, 228), Size = new Size(528, 20),
                ForeColor = Color.SeaGreen
            };
            goButton = new Button
            {
                Text = "安装", Location = new Point(452, 258), Size = new Size(92, 28)
            };
            goButton.Click += delegate { DoInstall(); };

            Controls.Add(head);
            Controls.Add(dirCaption);
            Controls.Add(dirBox);
            Controls.Add(browse);
            Controls.Add(deskCheck);
            Controls.Add(autoRunCheck);
            Controls.Add(svcLabel);
            Controls.Add(logLabel);
            Controls.Add(goButton);
            AcceptButton = goButton;
        }

        void Say(string text) { logLabel.Text = text; logLabel.Refresh(); }

        void DoInstall()
        {
            installDir = dirBox.Text.Trim();
            if (installDir == "")
            {
                MessageBox.Show("请填写安装目录。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            goButton.Enabled = false;
            try
            {
                InstallCore(deskCheck.Checked);
                Say("安装完成。");
                var choice = MessageBox.Show(
                    "安装完成。\n\n立即启动 " + AppName + "（托盘常驻 + 打开控制台）吗？",
                    AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (choice == DialogResult.Yes)
                {
                    Process.Start(new ProcessStartInfo(Path.Combine(installDir, ExeName)));
                }
                Application.Exit();
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装失败：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                goButton.Enabled = true;
            }
        }
    }

    /** 安装核心（向导与静默模式共用）。调用前 installDir/serverDir 必须就绪。 */
    static void InstallCore(bool deskShortcut)
    {
        Directory.CreateDirectory(installDir);

        string traySrc = Path.Combine(sourceDir, ExeName);
        if (!File.Exists(traySrc)) traySrc = Process.GetCurrentProcess().MainModule.FileName; // Setup 与托盘同目录分发
        File.Copy(traySrc, Path.Combine(installDir, ExeName), true);
        File.Copy(Process.GetCurrentProcess().MainModule.FileName, Path.Combine(installDir, "uninstall.exe"), true);
        File.WriteAllText(Path.Combine(installDir, "bridge-path.txt"), serverDir);
        File.WriteAllText(Path.Combine(installDir, "version.txt"), version);

        string menuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppName);
        Directory.CreateDirectory(menuDir);
        CreateShortcut(Path.Combine(menuDir, AppName + ".lnk"), Path.Combine(installDir, ExeName), installDir);
        CreateShortcut(Path.Combine(menuDir, "卸载 " + AppName + ".lnk"), Path.Combine(installDir, "uninstall.exe"), installDir);
        if (deskShortcut)
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"), Path.Combine(installDir, ExeName), installDir);

        using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RegUninstall))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("DisplayVersion", version);
            k.SetValue("Publisher", "workbuddy-bridge");
            k.SetValue("DisplayIcon", Path.Combine(installDir, ExeName));
            k.SetValue("InstallLocation", installDir);
            k.SetValue("UninstallString", "\"" + Path.Combine(installDir, "uninstall.exe") + "\" --uninstall");
            k.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
        }
        using (var run = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RegRun))
        {
            if (run.GetValue(AppName) != null) run.DeleteValue(AppName); // 开机自启只由向导勾选写入，静默安装不改动
        }
    }

    static void CreateShortcut(string lnkPath, string target, string workDir)
    {
        // 快捷方式指向 exe；lnk 已存在则覆盖
        if (File.Exists(lnkPath)) File.Delete(lnkPath);
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(shellType);
        try
        {
            dynamic lnk = shell.CreateShortcut(lnkPath);
            lnk.TargetPath = target;
            lnk.WorkingDirectory = workDir;
            lnk.Description = AppName;
            lnk.Save();
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.ReleaseComObject(shell);
        }
    }

    /* ---------------- 卸载（--uninstall） ---------------- */

    static void RunUninstall()
    {
        string installDir = null;
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RegUninstall))
                installDir = k != null ? (k.GetValue("InstallLocation") as string) : null;
        }
        catch { }
        if (installDir == null || !Directory.Exists(installDir)) installDir = AppDomain.CurrentDomain.BaseDirectory;

        if (MessageBox.Show("确定从这台电脑卸载 " + AppName + " 吗？\n\n（不会删除账号数据：账号池在 ~/.zcode/workbuddy-bridge，重装即恢复）",
            "卸载 " + AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

        try
        {
            // 停掉正在运行的托盘客户端（不碰代理服务——服务由插件自己管理）
            foreach (Process p in Process.GetProcessesByName("WorkBuddyBridgeTray")) { try { p.Kill(); p.WaitForExit(3000); } catch { } }
            foreach (Process p in Process.GetProcessesByName("WorkBuddyBridge")) { try { p.Kill(); p.WaitForExit(3000); } catch { } }

            string menuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppName);
            try { if (Directory.Exists(menuDir)) Directory.Delete(menuDir, true); } catch { }
            try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk")); } catch { }
            try
            {
                using (var run = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RegRun))
                {
                    if (run.GetValue(AppName) != null) run.DeleteValue(AppName);
                }
                Microsoft.Win32.Registry.CurrentUser.DeleteSubKey(RegUninstall);
            }
            catch { }

            // 延迟自删：uninstall.exe 自己也在安装目录里，交给 cmd 排队删
            Process.Start(new ProcessStartInfo("cmd.exe",
                "/c ping -n 3 127.0.0.1 > nul & rd /s /q \"" + installDir + "\"")
            { CreateNoWindow = true, UseShellExecute = false });

            MessageBox.Show("卸载完成。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("卸载出现错误：" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
