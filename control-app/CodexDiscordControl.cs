using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CodexDiscordControl
{
    internal enum ControlAction
    {
        Status,
        StartTemporary,
        StopTemporary,
        EnableLongTerm,
        DisableLongTerm
    }

    internal sealed class BackendResult
    {
        internal bool Started;
        internal bool TimedOut;
        internal int ExitCode;
        internal bool Ok;
        internal string ErrorCategory;
        internal string RawJson;
        internal Dictionary<string, object> Value;
    }

    internal sealed class BoundedReadResult
    {
        internal bool TooLarge;
        internal bool Failed;
        internal byte[] Bytes;
    }

    internal sealed class StatusRows
    {
        internal string BridgeService;
        internal string AutoStart;
        internal string Desktop;
        internal string Discord;
        internal string Activity;
        internal string Queue;

        internal static StatusRows Unknown()
        {
            return new StatusRows {
                BridgeService="未知", AutoStart="未知", Desktop="未知",
                Discord="未知", Activity="未知", Queue="未知"
            };
        }
    }

    internal sealed class ActionPresentation
    {
        internal string Message;
        internal StatusRows Rows;
    }

    internal static class StatusRenderer
    {
        internal static StatusRows Render(Dictionary<string, object> root)
        {
            Dictionary<string, object> service = Program.GetObject(root, "service");
            Dictionary<string, object> desktop = Program.GetObject(root, "desktop");
            Dictionary<string, object> discord = Program.GetObject(root, "discord");
            string mode = FormatMode(Program.GetString(service, "mode", null));
            string running = FormatBoolean(Program.GetBoolean(service, "running"), "运行中", "已停止");
            string gateway = FormatGateway(Program.GetString(discord, "state", null));
            string rest = FormatRest(Program.GetString(discord, "restState", null));

            return new StatusRows {
                BridgeService = "模式：" + mode + " · 状态：" + running,
                AutoStart = FormatBoolean(Program.GetBoolean(service, "autoStartEnabled"), "已开启", "已停用"),
                Desktop = FormatBoolean(Program.GetBoolean(desktop, "running"), "运行中", "未运行"),
                Discord = "Gateway：" + gateway + " · REST：" + rest,
                Activity = FormatActivity(Program.GetString(discord, "lastActivityAt", null)),
                Queue = FormatQueue(root)
            };
        }

        internal static ActionPresentation AfterSuccessfulAction(ControlAction action, BackendResult statusResult)
        {
            if (statusResult == null || !statusResult.Ok || statusResult.ExitCode != 0 || statusResult.Value == null)
            {
                return new ActionPresentation {
                    Message="操作已完成，但状态刷新失败。",
                    Rows=StatusRows.Unknown()
                };
            }
            return new ActionPresentation {
                Message=SuccessText(action),
                Rows=Render(statusResult.Value)
            };
        }

        internal static string SuccessText(ControlAction action)
        {
            switch (action)
            {
                case ControlAction.StartTemporary: return "桥接服务已临时开启。";
                case ControlAction.StopTemporary: return "桥接服务已临时停止。";
                case ControlAction.EnableLongTerm: return "桥接服务已长期启用并开启开机自启。";
                case ControlAction.DisableLongTerm: return "桥接服务已长期停用。";
                default: return "操作已完成。";
            }
        }

        private static string FormatMode(string value)
        {
            if (String.Equals(value, "scheduled", StringComparison.Ordinal)) { return "计划任务"; }
            if (String.Equals(value, "temporary", StringComparison.Ordinal)) { return "临时运行"; }
            return "未知";
        }

        private static string FormatBoolean(bool? value, string trueText, string falseText)
        {
            if (!value.HasValue) { return "未知"; }
            return value.Value ? trueText : falseText;
        }

        private static string FormatGateway(string value)
        {
            if (value == "ready" || value == "ok") { return "已连接"; }
            if (value == "connecting" || value == "reconnecting") { return "连接中"; }
            if (value == "stopped" || value == "offline" || value == "idle") { return "已断开"; }
            if (value == "failed") { return "故障"; }
            return "未知";
        }

        private static string FormatRest(string value)
        {
            if (value == "ready" || value == "ok") { return "正常"; }
            if (value == "connecting" || value == "reconnecting") { return "连接中"; }
            if (value == "stopped" || value == "offline" || value == "idle") { return "不可用"; }
            if (value == "failed") { return "故障"; }
            return "未知";
        }

        private static string FormatActivity(string value)
        {
            DateTimeOffset parsed;
            if (String.IsNullOrWhiteSpace(value) || !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed))
            {
                return "未知";
            }
            return parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
        }

        private static string FormatQueue(Dictionary<string, object> root)
        {
            object raw;
            if (root == null || !root.TryGetValue("queueCount", out raw) || raw == null || raw is bool) { return "未知"; }
            long count;
            if (raw is int) { count = (int)raw; }
            else if (raw is long) { count = (long)raw; }
            else if (raw is short) { count = (short)raw; }
            else if (raw is byte) { count = (byte)raw; }
            else { return "未知"; }
            if (count < 0 || count > Int32.MaxValue) { return "未知"; }
            return count.ToString(CultureInfo.InvariantCulture) + " 条";
        }
    }

    internal static class Program
    {
        private const int BackendTimeoutMilliseconds = 20000;
        private const int BackendCleanupMilliseconds = 2000;
        private const int MaximumBackendOutputBytes = 65536;

        private static readonly Dictionary<ControlAction, string> ActionNames =
            new Dictionary<ControlAction, string>
            {
                { ControlAction.Status, "status" },
                { ControlAction.StartTemporary, "start-temporary" },
                { ControlAction.StopTemporary, "stop-temporary" },
                { ControlAction.EnableLongTerm, "enable-long-term" },
                { ControlAction.DisableLongTerm, "disable-long-term" }
            };

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 1 && String.Equals(args[0], "--status-json", StringComparison.Ordinal))
            {
                return RunHeadlessStatus();
            }
            if (args.Length != 0)
            {
                WriteHeadlessJson("{\"ok\":false,\"errorCategory\":\"invalid-arguments\"}");
                return 2;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ControlForm());
            return 0;
        }

        private static int RunHeadlessStatus()
        {
            BackendResult result = InvokeBackend(ControlAction.Status);
            if (result.Value != null && !String.IsNullOrWhiteSpace(result.RawJson))
            {
                WriteHeadlessJson(result.RawJson);
                return result.ExitCode == 0 && result.Ok ? 0 : (result.ExitCode == 0 ? 1 : result.ExitCode);
            }

            WriteHeadlessJson("{\"ok\":false,\"errorCategory\":\"" + JsonEscape(FixedErrorCategory(result)) + "\"}");
            return result.ExitCode == 0 ? 1 : result.ExitCode;
        }

        private static void WriteHeadlessJson(string value)
        {
            string line = (value ?? String.Empty).Trim() + Environment.NewLine;
            byte[] bytes = new UTF8Encoding(false).GetBytes(line);
            IntPtr output = GetStdHandle(-11);
            uint written;
            if (output != IntPtr.Zero && output != new IntPtr(-1) && WriteFile(output, bytes, (uint)bytes.Length, out written, IntPtr.Zero))
            {
                return;
            }
            Console.Out.Write(line);
            Console.Out.Flush();
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteFile(IntPtr handle, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);

        private static string JsonEscape(string value)
        {
            return (value ?? "control-failed").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        internal static BackendResult InvokeBackend(ControlAction action)
        {
            return InvokeBackendCore(action, BackendTimeoutMilliseconds, BackendCleanupMilliseconds);
        }

        internal static BackendResult InvokeBackendForTest(ControlAction action, int timeoutMilliseconds, int cleanupMilliseconds)
        {
            if (timeoutMilliseconds < 1 || timeoutMilliseconds > BackendTimeoutMilliseconds || cleanupMilliseconds < 1 || cleanupMilliseconds > BackendCleanupMilliseconds)
            {
                return new BackendResult { ExitCode=1, Ok=false, ErrorCategory="invalid-deadline" };
            }
            return InvokeBackendCore(action, timeoutMilliseconds, cleanupMilliseconds);
        }

        private static BackendResult InvokeBackendCore(ControlAction action, int timeoutMilliseconds, int cleanupMilliseconds)
        {
            BackendResult result = new BackendResult
            {
                Started = false,
                TimedOut = false,
                ExitCode = 1,
                Ok = false,
                ErrorCategory = "backend-unavailable"
            };

            string actionName;
            if (!ActionNames.TryGetValue(action, out actionName))
            {
                result.ErrorCategory = "invalid-action";
                return result;
            }

            string baseDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string backendPath = Path.Combine(baseDirectory, "codex-control.ps1");
            string powershellPath = ResolvePowerShell7Path();
            if (!File.Exists(backendPath) || powershellPath == null)
            {
                return result;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = powershellPath;
            startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -File " + QuoteArgument(backendPath) + " -Action " + actionName;
            startInfo.WorkingDirectory = baseDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;

            try
            {
                using (Process process = new Process())
                {
                    process.StartInfo = startInfo;
                    result.Started = process.Start();
                    if (!result.Started)
                    {
                        return result;
                    }

                    int limitKillRequested = 0;
                    Action stopForLimit = delegate
                    {
                        if (System.Threading.Interlocked.CompareExchange(ref limitKillRequested, 1, 0) == 0)
                        {
                            TryKill(process);
                        }
                    };
                    Task<BoundedReadResult> stdoutTask = Task.Run(delegate { return ReadStreamBounded(process.StandardOutput.BaseStream, stopForLimit); });
                    Task<BoundedReadResult> stderrTask = Task.Run(delegate { return ReadStreamBounded(process.StandardError.BaseStream, stopForLimit); });

                    bool exited = process.WaitForExit(timeoutMilliseconds);
                    if (!exited)
                    {
                        result.TimedOut = true;
                        result.ErrorCategory = "backend-timeout";
                        TryKill(process);
                        try { exited = process.WaitForExit(cleanupMilliseconds); }
                        catch { exited = false; }
                    }
                    if (!exited)
                    {
                        result.ErrorCategory = "backend-cleanup-failed";
                        ObserveTask(stdoutTask);
                        ObserveTask(stderrTask);
                        return result;
                    }

                    bool readersCompleted;
                    try { readersCompleted = Task.WaitAll(new Task[] { stdoutTask, stderrTask }, cleanupMilliseconds); }
                    catch { readersCompleted = false; }
                    if (!readersCompleted)
                    {
                        result.ErrorCategory = "backend-stream-failed";
                        ObserveTask(stdoutTask);
                        ObserveTask(stderrTask);
                        return result;
                    }

                    result.ExitCode = process.ExitCode;
                    BoundedReadResult stdout = stdoutTask.Result;
                    BoundedReadResult stderr = stderrTask.Result;
                    if (stdout.TooLarge || stderr.TooLarge)
                    {
                        result.ErrorCategory = "backend-output-too-large";
                        return result;
                    }
                    if (stdout.Failed || stderr.Failed)
                    {
                        result.ErrorCategory = "backend-stream-failed";
                        return result;
                    }
                    if (result.TimedOut)
                    {
                        return result;
                    }

                    string output;
                    try { output = new UTF8Encoding(false, true).GetString(stdout.Bytes ?? new byte[0]).Trim(); }
                    catch
                    {
                        result.ErrorCategory = "invalid-backend-response";
                        return result;
                    }
                    if (output.Length == 0 || output.IndexOf('\n') >= 0 || output.IndexOf('\r') >= 0)
                    {
                        result.ErrorCategory = "invalid-backend-response";
                        return result;
                    }

                    Dictionary<string, object> parsed = ParseJsonObject(output);
                    if (parsed == null || !parsed.ContainsKey("ok") || !(parsed["ok"] is bool))
                    {
                        result.ErrorCategory = "invalid-backend-response";
                        return result;
                    }

                    result.RawJson = output;
                    result.Value = parsed;
                    result.Ok = (bool)parsed["ok"];
                    result.ErrorCategory = GetString(parsed, "errorCategory", result.Ok ? null : "backend-action-failed");
                    return result;
                }
            }
            catch
            {
                result.ErrorCategory = "backend-unavailable";
                return result;
            }
        }

        private static void ObserveTask(Task task)
        {
            if (task == null) { return; }
            task.ContinueWith(delegate(Task completed) { var ignored = completed.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        }

        private static BoundedReadResult ReadStreamBounded(Stream stream, Action onTooLarge)
        {
            BoundedReadResult result = new BoundedReadResult { Bytes = new byte[0] };
            try
            {
                using (MemoryStream saved = new MemoryStream())
                {
                    byte[] buffer = new byte[4096];
                    while (true)
                    {
                        int read = stream.Read(buffer, 0, buffer.Length);
                        if (read <= 0) { break; }
                        if (saved.Length + read > MaximumBackendOutputBytes)
                        {
                            result.TooLarge = true;
                            try { onTooLarge(); }
                            catch { }
                            return result;
                        }
                        saved.Write(buffer, 0, read);
                    }
                    result.Bytes = saved.ToArray();
                    return result;
                }
            }
            catch
            {
                result.Failed = true;
                return result;
            }
        }

        private static void TryKill(Process process)
        {
            try
            {
                if (process != null && !process.HasExited) { process.Kill(); }
            }
            catch { }
        }

        private static string QuoteArgument(string value)
        {
            if (value == null || value.IndexOf('"') >= 0)
            {
                throw new InvalidOperationException();
            }
            return "\"" + value + "\"";
        }

        private static string ResolvePowerShell7Path()
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (String.IsNullOrWhiteSpace(programFiles)) { return null; }
            string candidate = Path.Combine(programFiles, "PowerShell", "7", "pwsh.exe");
            return File.Exists(candidate) ? candidate : null;
        }

        private static Dictionary<string, object> ParseJsonObject(string json)
        {
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaximumBackendOutputBytes;
                return serializer.DeserializeObject(json) as Dictionary<string, object>;
            }
            catch { return null; }
        }

        internal static Dictionary<string, object> GetObject(Dictionary<string, object> parent, string name)
        {
            object value;
            if (parent != null && parent.TryGetValue(name, out value))
            {
                return value as Dictionary<string, object>;
            }
            return null;
        }

        internal static string GetString(Dictionary<string, object> value, string name, string fallback)
        {
            object item;
            if (value != null && value.TryGetValue(name, out item) && item is string)
            {
                return (string)item;
            }
            return fallback;
        }

        internal static bool? GetBoolean(Dictionary<string, object> value, string name)
        {
            object item;
            if (value != null && value.TryGetValue(name, out item) && item is bool)
            {
                return (bool)item;
            }
            return null;
        }

        internal static string FixedErrorCategory(BackendResult result)
        {
            if (result == null) { return "control-failed"; }
            if (result.TimedOut) { return "backend-timeout"; }
            switch (result.ErrorCategory)
            {
                case "backend-unavailable":
                case "backend-timeout":
                case "backend-output-too-large":
                case "backend-stream-failed":
                case "backend-cleanup-failed":
                case "invalid-backend-response":
                case "invalid-action":
                    return result.ErrorCategory;
                default:
                    return "control-failed";
            }
        }
    }

    internal sealed class ControlForm : Form
    {
        private readonly Label bridgeServiceValue;
        private readonly Label autoStartValue;
        private readonly Label desktopValue;
        private readonly Label discordValue;
        private readonly Label activityValue;
        private readonly Label queueValue;
        private readonly Label resultLabel;
        private readonly Button refreshButton;
        private readonly List<Button> actionButtons;
        private readonly Timer refreshTimer;
        private bool requestRunning;

        internal ControlForm()
        {
            Text = "Codex Discord 控制台";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(620, 430);
            Size = new Size(680, 470);
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = Color.White;

            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.Padding = new Padding(22);
            root.ColumnCount = 1;
            root.RowCount = 4;
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(root);

            Label heading = new Label();
            heading.Text = "Discord 桥接服务";
            heading.AutoSize = true;
            heading.Font = new Font(Font.FontFamily, 16F, FontStyle.Bold);
            heading.Margin = new Padding(0, 0, 0, 16);
            root.Controls.Add(heading, 0, 0);

            TableLayoutPanel status = new TableLayoutPanel();
            status.Dock = DockStyle.Top;
            status.AutoSize = true;
            status.ColumnCount = 2;
            status.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190F));
            status.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            status.RowCount = 6;
            bridgeServiceValue = AddStatusRow(status, 0, "桥接服务");
            autoStartValue = AddStatusRow(status, 1, "开机自启");
            desktopValue = AddStatusRow(status, 2, "Codex 桌面端");
            discordValue = AddStatusRow(status, 3, "Discord");
            activityValue = AddStatusRow(status, 4, "最近活动");
            queueValue = AddStatusRow(status, 5, "继续队列");
            root.Controls.Add(status, 0, 1);

            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.Dock = DockStyle.Fill;
            actions.AutoSize = true;
            actions.WrapContents = true;
            actions.Margin = new Padding(0, 18, 0, 8);
            actionButtons = new List<Button>();
            actionButtons.Add(AddActionButton(actions, "临时开启", ControlAction.StartTemporary));
            actionButtons.Add(AddActionButton(actions, "临时停止", ControlAction.StopTemporary));
            actionButtons.Add(AddActionButton(actions, "长期启用（开机自启）", ControlAction.EnableLongTerm));
            actionButtons.Add(AddActionButton(actions, "长期停用", ControlAction.DisableLongTerm));
            refreshButton = new Button();
            refreshButton.Text = "刷新";
            refreshButton.AutoSize = true;
            refreshButton.Padding = new Padding(10, 5, 10, 5);
            refreshButton.Click += async delegate { await RefreshStatusAsync(false); };
            actions.Controls.Add(refreshButton);
            root.Controls.Add(actions, 0, 2);

            resultLabel = new Label();
            resultLabel.Text = "正在读取状态…";
            resultLabel.AutoEllipsis = true;
            resultLabel.Dock = DockStyle.Fill;
            resultLabel.Height = 38;
            resultLabel.Padding = new Padding(10, 9, 10, 8);
            resultLabel.BackColor = Color.FromArgb(245, 247, 250);
            resultLabel.ForeColor = Color.FromArgb(55, 65, 81);
            root.Controls.Add(resultLabel, 0, 3);

            refreshTimer = new Timer();
            refreshTimer.Interval = 2000;
            refreshTimer.Tick += async delegate { await RefreshStatusAsync(true); };
            Shown += async delegate
            {
                refreshTimer.Start();
                await RefreshStatusAsync(false);
            };
            FormClosed += delegate { refreshTimer.Stop(); };
        }

        private static Label AddStatusRow(TableLayoutPanel table, int row, string caption)
        {
            Label name = new Label();
            name.Text = caption;
            name.AutoSize = true;
            name.ForeColor = Color.FromArgb(75, 85, 99);
            name.Margin = new Padding(0, 7, 0, 7);
            Label value = new Label();
            value.Text = "未知";
            value.AutoSize = true;
            value.Font = new Font(table.Font, FontStyle.Bold);
            value.Margin = new Padding(0, 7, 0, 7);
            table.Controls.Add(name, 0, row);
            table.Controls.Add(value, 1, row);
            return value;
        }

        private Button AddActionButton(FlowLayoutPanel panel, string caption, ControlAction action)
        {
            Button button = new Button();
            button.Text = caption;
            button.AutoSize = true;
            button.Padding = new Padding(10, 5, 10, 5);
            button.Margin = new Padding(0, 0, 8, 8);
            button.Click += async delegate { await ExecuteActionAsync(action); };
            panel.Controls.Add(button);
            return button;
        }

        private async Task ExecuteActionAsync(ControlAction action)
        {
            if (requestRunning) { return; }
            if (action == ControlAction.DisableLongTerm)
            {
                DialogResult confirmation = MessageBox.Show(
                    this,
                    "长期停用会停止当前桥接服务，并关闭今后的开机自启。确定继续吗？",
                    "确认长期停用",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2);
                if (confirmation != DialogResult.Yes) { return; }
            }

            SetBusy(true);
            resultLabel.Text = "正在执行…";
            try
            {
                BackendResult actionResult = await Task.Run(delegate { return Program.InvokeBackend(action); });
                bool actionSucceeded = actionResult.Ok && actionResult.ExitCode == 0;
                if (!actionSucceeded)
                {
                    resultLabel.Text = ChineseError(Program.FixedErrorCategory(actionResult));
                }

                BackendResult statusResult = await Task.Run(delegate { return Program.InvokeBackend(ControlAction.Status); });
                if (actionSucceeded)
                {
                    ActionPresentation presentation = StatusRenderer.AfterSuccessfulAction(action, statusResult);
                    ApplyRows(presentation.Rows);
                    resultLabel.Text = presentation.Message;
                }
                else if (statusResult.Ok && statusResult.ExitCode == 0 && statusResult.Value != null)
                {
                    ApplyRows(StatusRenderer.Render(statusResult.Value));
                }
                else { ApplyRows(StatusRows.Unknown()); }
            }
            catch
            {
                ApplyRows(StatusRows.Unknown());
                resultLabel.Text = "操作失败，请稍后重试。";
            }
            finally { SetBusy(false); }
        }

        private async Task RefreshStatusAsync(bool automatic)
        {
            if (requestRunning) { return; }
            SetBusy(true);
            if (!automatic) { resultLabel.Text = "正在刷新状态…"; }
            try
            {
                BackendResult result = await Task.Run(delegate { return Program.InvokeBackend(ControlAction.Status); });
                if (result.Ok && result.ExitCode == 0)
                {
                    ApplyRows(StatusRenderer.Render(result.Value));
                    if (!automatic) { resultLabel.Text = "状态已更新。"; }
                }
                else
                {
                    ApplyRows(StatusRows.Unknown());
                    resultLabel.Text = ChineseError(Program.FixedErrorCategory(result));
                }
            }
            catch
            {
                ApplyRows(StatusRows.Unknown());
                resultLabel.Text = "状态读取失败，请稍后重试。";
            }
            finally { SetBusy(false); }
        }

        private void SetBusy(bool value)
        {
            requestRunning = value;
            SetActionButtonsEnabled(!value);
            refreshButton.Enabled = !value;
        }

        private void SetActionButtonsEnabled(bool enabled)
        {
            foreach (Button button in actionButtons) { button.Enabled = enabled; }
        }

        private void ApplyRows(StatusRows rows)
        {
            StatusRows safe = rows ?? StatusRows.Unknown();
            bridgeServiceValue.Text = safe.BridgeService ?? "未知";
            autoStartValue.Text = safe.AutoStart ?? "未知";
            desktopValue.Text = safe.Desktop ?? "未知";
            discordValue.Text = safe.Discord ?? "未知";
            activityValue.Text = safe.Activity ?? "未知";
            queueValue.Text = safe.Queue ?? "未知";
        }

        private static string ChineseError(string category)
        {
            switch (category)
            {
                case "backend-unavailable": return "控制后端不可用。";
                case "backend-timeout": return "操作超时，请稍后重试。";
                case "backend-output-too-large": return "控制后端输出异常。";
                case "backend-stream-failed": return "控制后端通信异常。";
                case "backend-cleanup-failed": return "控制后端未能安全结束。";
                case "invalid-backend-response": return "状态格式异常，请稍后重试。";
                default: return "操作失败，请稍后重试。";
            }
        }
    }
}
