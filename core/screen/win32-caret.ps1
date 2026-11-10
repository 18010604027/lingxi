param([switch]$Once, [switch]$All)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, Accessibility -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using Accessibility;
namespace InputFocusProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo {
    public uint Size, Flags;
    public IntPtr Active, Focus, Capture, Menu, Move, Caret;
    public Rect Bounds;
  }
  public class Area {
    public string kind, source, window;
    public int x, y, width, height, pid;
    public int? controlType;
  }
  public class Result { public Area gui, msaa, uia; public Area selected; }
  public static class Probe {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    public static void Initialize() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    static Area AreaOf(IntPtr window, string source, string kind, int x, int y, int width, int height, int? controlType) {
      if (height <= 0 || width < 0) return null;
      uint pid; GetWindowThreadProcessId(window, out pid);
      return new Area { window = window.ToInt64().ToString("x"), pid = (int)pid, source = source, kind = kind, x = x, y = y, width = width, height = height, controlType = controlType };
    }
    public static Area Gui(IntPtr window) {
      uint pid; uint thread = GetWindowThreadProcessId(window, out pid);
      GuiInfo info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
      if (!GetGUIThreadInfo(thread, ref info) || info.Caret == IntPtr.Zero) return null;
      Point a = new Point { X = info.Bounds.Left, Y = info.Bounds.Top }, b = new Point { X = info.Bounds.Right, Y = info.Bounds.Bottom };
      if (!ClientToScreen(info.Caret, ref a) || !ClientToScreen(info.Caret, ref b)) return null;
      return AreaOf(window, "gui-thread", "caret", a.X, a.Y, b.X-a.X, b.Y-a.Y, null);
    }
    static Area Msaa(IntPtr window) {
      IAccessible accessible = null;
      try {
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        if (AccessibleObjectFromWindow(IntPtr.Zero, unchecked((uint)-8), ref iid, out accessible) < 0 || accessible == null) return null;
        int x, y, width, height;
        accessible.accLocation(out x, out y, out width, out height, 0);
        return AreaOf(window, "msaa", "caret", x, y, width, height, null);
      } catch { return null; }
      finally { if (accessible != null) Marshal.ReleaseComObject(accessible); }
    }
    static Area Uia(IntPtr window) {
      try {
        AutomationElement focus = AutomationElement.FocusedElement;
        if (focus == null || focus.Current.IsOffscreen) return null;
        AutomationElement ancestor = focus;
        bool sameWindow = false;
        for (int i = 0; i < 32 && ancestor != null; i++) {
          int handle = ancestor.Current.NativeWindowHandle;
          if (handle != 0 && GetAncestor(new IntPtr(handle), 2) == window) { sameWindow = true; break; }
          ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
        }
        if (!sameWindow) return null;
        System.Windows.Rect bounds = focus.Current.BoundingRectangle;
        if (bounds.IsEmpty || Double.IsInfinity(bounds.X) || Double.IsInfinity(bounds.Y)) return null;
        return AreaOf(window, "uia", "focus", (int)Math.Floor(bounds.X), (int)Math.Floor(bounds.Y), (int)Math.Ceiling(bounds.Width), (int)Math.Ceiling(bounds.Height), focus.Current.ControlType.Id);
      } catch { return null; }
    }
    public static Result Read(string expected, bool all) {
      IntPtr window = GetForegroundWindow();
      if (window == IntPtr.Zero || expected != null && window.ToInt64().ToString("x") != expected) return new Result();
      using (Timer watchdog = new Timer(state => Environment.Exit(29), null, 2000, Timeout.Infinite)) {
        Result result = new Result { gui = Gui(window) };
        if (all || result.gui == null) result.msaa = Msaa(window);
        if (all || result.gui == null && result.msaa == null) result.uia = Uia(window);
        if (GetForegroundWindow() != window) return new Result();
        result.selected = result.gui ?? result.msaa ?? result.uia;
        return result;
      }
    }
  }
}
'@
[InputFocusProbe.Probe]::Initialize()
if ($Once) {
  [InputFocusProbe.Probe]::Read($null, $All.IsPresent) | ConvertTo-Json -Depth 5 -Compress
  exit
}
Write-Output 'ready'
while ($null -ne ($focusWindow = [Console]::ReadLine())) {
  [InputFocusProbe.Probe]::Read($focusWindow, $false) | ConvertTo-Json -Depth 5 -Compress
}
