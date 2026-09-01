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

    internal static class Program
    {
        private const int BackendTimeoutMilliseconds = 20000;
        private const int MaximumBackendOutputCharacters = 65536;

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

                    Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
                    Task<string> stderrTask = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(BackendTimeoutMilliseconds))
                    {
                        result.TimedOut = true;
                        result.ErrorCategory = "backend-timeout";
                        try { process.Kill(); }
                        catch { }
                        try { process.WaitForExit(1000); }
                        catch { }
                        ObserveTask(stdoutTask);
                        ObserveTask(stderrTask);
                        return result;
                    }

                    Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 2000);
                    result.ExitCode = process.ExitCode;
                    string output = stdoutTask.IsCompleted ? stdoutTask.Result.Trim() : String.Empty;
                    if (output.Length == 0 || output.Length > MaximumBackendOutputCharacters || output.IndexOf('\n') >= 0 || output.IndexOf('\r') >= 0)
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
                serializer.MaxJsonLength = MaximumBackendOutputCharacters;
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
        private readonly Label modeValue;
        private readonly Label runningValue;
        private readonly Label autoStartValue;
        private readonly Label gatewayValue;
        private readonly Label restValue;
        private readonly Label activityValue;
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
            modeValue = AddStatusRow(status, 0, "服务模式");
            runningValue = AddStatusRow(status, 1, "服务运行");
            autoStartValue = AddStatusRow(status, 2, "开机自启");
            gatewayValue = AddStatusRow(status, 3, "Discord Gateway");
            restValue = AddStatusRow(status, 4, "Discord REST");
            activityValue = AddStatusRow(status, 5, "最近活动");
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
                if (actionResult.Ok && actionResult.ExitCode == 0)
                {
                    resultLabel.Text = SuccessText(action);
                }
                else
                {
                    resultLabel.Text = ChineseError(Program.FixedErrorCategory(actionResult));
                }

                BackendResult statusResult = await Task.Run(delegate { return Program.InvokeBackend(ControlAction.Status); });
                if (statusResult.Ok && statusResult.ExitCode == 0)
                {
                    ApplyStatus(statusResult.Value);
                }
            }
            catch
            {
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
                    ApplyStatus(result.Value);
                    if (!automatic) { resultLabel.Text = "状态已更新。"; }
                }
                else
                {
                    resultLabel.Text = ChineseError(Program.FixedErrorCategory(result));
                }
            }
            catch
            {
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

        private void ApplyStatus(Dictionary<string, object> root)
        {
            Dictionary<string, object> service = Program.GetObject(root, "service");
            Dictionary<string, object> discord = Program.GetObject(root, "discord");
            modeValue.Text = FormatMode(Program.GetString(service, "mode", "unknown"));
            runningValue.Text = FormatBoolean(Program.GetBoolean(service, "running"), "运行中", "已停止");
            autoStartValue.Text = FormatBoolean(Program.GetBoolean(service, "autoStartEnabled"), "已开启", "已停用");
            gatewayValue.Text = FormatGateway(Program.GetString(discord, "state", "unknown"));
            restValue.Text = FormatRest(Program.GetString(discord, "restState", "unknown"));
            activityValue.Text = FormatActivity(Program.GetString(discord, "lastActivityAt", null));
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

        private static string SuccessText(ControlAction action)
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

        private static string ChineseError(string category)
        {
            switch (category)
            {
                case "backend-unavailable": return "控制后端不可用。";
                case "backend-timeout": return "操作超时，请稍后重试。";
                case "invalid-backend-response": return "状态格式异常，请稍后重试。";
                default: return "操作失败，请稍后重试。";
            }
        }
    }
}
