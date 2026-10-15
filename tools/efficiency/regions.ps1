<#
  regions.ps1 -- where a process's COMMIT lives, by walking its address space (VirtualQueryEx), for
  mem-bench.js. Read-only: it opens each process for query + read and never writes to one.

    powershell -NoProfile -File tools/efficiency/regions.ps1 -Pids 123,456 -Out regions.json

  Per pid: { pid, privMB, mappedMB, imageWMB, images: [[dll, MB]...], buckets: {...}, top: [...] }
    privMB    committed MEM_PRIVATE (VirtualAlloc'd: heaps, V8, PartitionAlloc, stacks)
    imageWMB  committed WRITABLE pages of loaded images (DLL/EXE data sections; charged as commit)
    images    imageWMB by module, largest first
    buckets   privMB by the size of the reservation it sits in (a 4 GB+ reservation is a V8 cage or
              an allocator pool; small ones are heap segments, stacks, one-off VirtualAllocs)
    top       the 12 reservations holding the most private commit: [reserveMB, commitMB, protect]
#>
param([Parameter(Mandatory = $true)][string]$Pids, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class QRegions {
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public ushort PartitionId; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
  [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetMappedFileNameW(IntPtr h, IntPtr addr, StringBuilder sb, uint n);
  static string Mb(long b) { return (b / 1048576.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture); }
  public static string Walk(int pid) {
    IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
    if (h == IntPtr.Zero) return "{\"pid\":" + pid + ",\"error\":\"OpenProcess failed\"}";
    long priv = 0, mapped = 0, imageW = 0, addr = 0;
    var img = new Dictionary<string, long>();
    var resv = new Dictionary<long, long>();
    var privBy = new Dictionary<long, long>();
    var protBy = new Dictionary<long, uint>();
    int size = Marshal.SizeOf(typeof(MBI));
    MBI m;
    while (VirtualQueryEx(h, new IntPtr(addr), out m, new IntPtr(size)) != IntPtr.Zero) {
      long rs = m.RegionSize.ToInt64();
      long ab = m.AllocationBase.ToInt64();
      if (m.State != 0x10000) { long r; resv.TryGetValue(ab, out r); resv[ab] = r + rs; }
      if (m.State == 0x1000) {
        if (m.Type == 0x20000) { priv += rs; long p; privBy.TryGetValue(ab, out p); privBy[ab] = p + rs; protBy[ab] = m.Protect; }
        else if (m.Type == 0x40000) mapped += rs;
        else if (m.Type == 0x1000000) {
          uint pr = m.Protect & 0xFF;
          if (pr == 0x04 || pr == 0x08 || pr == 0x40 || pr == 0x80) {
            imageW += rs;
            var sb = new StringBuilder(520);
            GetMappedFileNameW(h, m.BaseAddress, sb, 520);
            string n = sb.ToString(); n = n.Substring(n.LastIndexOf('\\') + 1).ToLowerInvariant();
            long v; img.TryGetValue(n, out v); img[n] = v + rs;
          }
        }
      }
      long next = m.BaseAddress.ToInt64() + rs;
      if (next <= addr) break;
      addr = next;
    }
    CloseHandle(h);
    var buckets = new SortedDictionary<string, long>();
    var top = new List<long[]>();
    foreach (var kv in privBy) {
      long r; resv.TryGetValue(kv.Key, out r);
      string b = r >= (1L << 32) ? "a_>=4GB" : r >= (256L << 20) ? "b_256MB-4GB" : r >= (16L << 20) ? "c_16-256MB" : r >= (2L << 20) ? "d_2-16MB" : r >= (1L << 20) ? "e_1-2MB" : "f_<1MB";
      long v; buckets.TryGetValue(b, out v); buckets[b] = v + kv.Value;
      top.Add(new long[] { r, kv.Value, protBy[kv.Key] });
    }
    top.Sort((x, y) => y[1].CompareTo(x[1]));
    var images = new List<KeyValuePair<string, long>>(img);
    images.Sort((x, y) => y.Value.CompareTo(x.Value));
    var o = new StringBuilder();
    o.Append("{\"pid\":" + pid + ",\"privMB\":" + Mb(priv) + ",\"mappedMB\":" + Mb(mapped) + ",\"imageWMB\":" + Mb(imageW) + ",\"images\":[");
    for (int i = 0; i < images.Count && i < 25; i++) { if (i > 0) o.Append(","); o.Append("[\"" + images[i].Key.Replace("\\", "/").Replace("\"", "") + "\"," + Mb(images[i].Value) + "]"); }
    o.Append("],\"buckets\":{");
    bool first = true;
    foreach (var kv in buckets) { if (!first) o.Append(","); first = false; o.Append("\"" + kv.Key + "\":" + Mb(kv.Value)); }
    o.Append("},\"top\":[");
    for (int i = 0; i < top.Count && i < 12; i++) { if (i > 0) o.Append(","); o.Append("[" + Mb(top[i][0]) + "," + Mb(top[i][1]) + "," + top[i][2] + "]"); }
    o.Append("],\"reservations\":" + privBy.Count + "}");
    return o.ToString();
  }
}
"@
$parts = @()
foreach ($p in ($Pids -split ',')) { if ($p) { $parts += [QRegions]::Walk([int]$p) } }
[System.IO.File]::WriteAllText($Out, '[' + ($parts -join ',') + ']', (New-Object System.Text.UTF8Encoding($false)))
