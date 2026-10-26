using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class PortableLauncher {
    static string root;
    static string Mime(string path) {
        switch (Path.GetExtension(path).ToLowerInvariant()) {
            case ".html": return "text/html; charset=utf-8";
            case ".js": return "application/javascript; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".png": return "image/png";
            case ".jpg": return "image/jpeg";
            case ".webp": return "image/webp";
            default: return "application/octet-stream";
        }
    }
    static void Serve(object value) {
        using (TcpClient client = (TcpClient)value) {
            client.ReceiveTimeout = 10000;
            try {
                using (NetworkStream stream = client.GetStream()) {
                    StreamReader reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    string first = reader.ReadLine();
                    if (first == null) return;
                    string header; int total = first.Length;
                    while (!String.IsNullOrEmpty(header = reader.ReadLine())) { total += header.Length; if (total > 32768) return; }
                    string[] parts = first.Split(' ');
                    if (parts.Length < 2 || (parts[0] != "GET" && parts[0] != "HEAD")) return;
                    string relative = Uri.UnescapeDataString(parts[1].Split('?')[0]).TrimStart('/');
                    if (relative == "") relative = "sandbox.html";
                    string path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
                    bool found = path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(path);
                    byte[] bytes = found ? File.ReadAllBytes(path) : Encoding.UTF8.GetBytes("자료를 찾을 수 없습니다.");
                    string response = "HTTP/1.1 " + (found ? "200 OK" : "404 Not Found") + "\r\nContent-Type: " + (found ? Mime(path) : "text/plain; charset=utf-8") + "\r\nContent-Length: " + bytes.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                    byte[] head = Encoding.ASCII.GetBytes(response); stream.Write(head, 0, head.Length);
                    if (parts[0] != "HEAD") stream.Write(bytes, 0, bytes.Length);
                }
            } catch (IOException) { } catch (SocketException) { } catch (Exception) { }
        }
    }
    [STAThread]
    static void Main(string[] args) {
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        try {
            TcpListener listener = new TcpListener(IPAddress.Loopback, 8768);
            try { listener.Start(); } catch (SocketException) { listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); }
            if (args.Length > 0 && args[0] == "--verify") { while (true) ThreadPool.QueueUserWorkItem(Serve, listener.AcceptTcpClient()); }
            string url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/sandbox.html";
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Application.EnableVisualStyles();
            Form window = new Form { Text = "전투 실험 시뮬레이터", Width = 460, Height = 170, StartPosition = FormStartPosition.CenterScreen };
            Label label = new Label { Text = "브라우저에서 전투 실험을 실행했습니다.\n이 창을 닫으면 시뮬레이터 실행이 종료됩니다.\n인터넷 연결이나 별도 설치는 필요하지 않습니다.", Dock = DockStyle.Fill, Padding = new Padding(18), AutoSize = false };
            window.Controls.Add(label);
            Thread worker = new Thread(delegate() { try { while (true) ThreadPool.QueueUserWorkItem(Serve, listener.AcceptTcpClient()); } catch (SocketException) { } catch (ObjectDisposedException) { } });
            worker.IsBackground = true; worker.Start();
            Application.Run(window); listener.Stop();
        } catch (Exception e) { MessageBox.Show("실행하지 못했습니다.\n" + e.Message, "전투 실험 시뮬레이터"); }
    }
}
