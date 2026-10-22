using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class Launcher
{
    // CommandLineToArgvW quoting, including trailing slashes and embedded quotes.
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "source", "Installer.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("请先完整解压安装包；EXE 需要同目录的 source 和 plugin 文件夹。", script);
            string shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            string command = "-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File " + Quote(script);
            foreach (string arg in args) command += " " + Quote(arg);
            var start = new ProcessStartInfo(shell, command);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardError = true;
            using (Process process = Process.Start(start))
            {
                var errorOutput = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                string detail = errorOutput.GetAwaiter().GetResult();
                // GUI startup failures otherwise vanish with the hidden shell.
                // Command-line automation receives the exit code without dialogs.
                bool background = Array.Exists(args, arg =>
                    String.Equals(arg, "-Apply", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(arg, "-Discover", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(arg, "-UpdateOnly", StringComparison.OrdinalIgnoreCase));
                if (process.ExitCode != 0 && !background)
                    MessageBox.Show("安装器未能启动。请确认安装包已完整解压，系统允许 Windows PowerShell 和 .NET Framework 运行。\n\n" +
                        (detail.Length > 2500 ? detail.Substring(0, 2500) : detail), "AI Hypnotic device", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "双白 DSH 安装器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
