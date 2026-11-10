param([switch]$Once)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
namespace VoiceOutput {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid Format; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Variant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public uint Value;
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class EnumeratorClass {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Enumerator {
    [PreserveSig] int EnumEndpoints(int flow, uint mask, out IntPtr collection);
    [PreserveSig] int GetDefault(int flow, int role, out Device device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out Device device);
    [PreserveSig] int Register(Notifications callback);
    [PreserveSig] int Unregister(Notifications callback);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Device {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activation, out IntPtr instance);
    [PreserveSig] int OpenStore(uint access, out Store store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Store {
    [PreserveSig] int Count(out uint count);
    [PreserveSig] int Key(uint index, out PropertyKey key);
    [PreserveSig] int Get(ref PropertyKey key, out Variant value);
    [PreserveSig] int Set(ref PropertyKey key, ref Variant value);
    [PreserveSig] int Commit();
  }
  [ComVisible(true), Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Notifications {
    [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, uint state);
    [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
  }
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public class Watcher : Notifications, IDisposable {
    private Enumerator enumerator = (Enumerator)new EnumeratorClass();
    private long revision = 1;
    public long Revision { get { return Interlocked.Read(ref revision); } }
    public Watcher() { Marshal.ThrowExceptionForHR(enumerator.Register(this)); }
    public int OnDeviceStateChanged(string id, uint state) { Interlocked.Increment(ref revision); return 0; }
    public int OnDeviceAdded(string id) { Interlocked.Increment(ref revision); return 0; }
    public int OnDeviceRemoved(string id) { Interlocked.Increment(ref revision); return 0; }
    public int OnDefaultDeviceChanged(int flow, int role, string id) { Interlocked.Increment(ref revision); return 0; }
    public int OnPropertyValueChanged(string id, PropertyKey key) { Interlocked.Increment(ref revision); return 0; }
    public Snapshot Read() {
      for (int attempt = 0; attempt < 3; attempt++) {
        long before = Revision;
        Device device = null; Store store = null;
        try {
          if (enumerator.GetDefault(0, 0, out device) < 0) return new Snapshot { Revision = Revision };
          string id; Marshal.ThrowExceptionForHR(device.GetId(out id));
          Marshal.ThrowExceptionForHR(device.OpenStore(0, out store));
          PropertyKey key = new PropertyKey { Format = new Guid("1DA5D803-D492-4EDD-8C23-E0C0FFE7F0CA"), Id = 0 };
          Variant value; Marshal.ThrowExceptionForHR(store.Get(ref key, out value));
          int factor;
          try { factor = value.Type == 19 ? (int)value.Value : -1; }
          finally { Clear(ref value); }
          long after = Revision;
          if (before == after) return new Snapshot { Id = id, FormFactor = factor, Revision = after };
        } finally {
          if (store != null) Marshal.ReleaseComObject(store);
          if (device != null) Marshal.ReleaseComObject(device);
        }
      }
      return new Snapshot { Revision = Revision };
    }
    public void Dispose() { enumerator.Unregister(this); Marshal.ReleaseComObject(enumerator); }
    [DllImport("ole32.dll", EntryPoint="PropVariantClear")] private static extern int Clear(ref Variant value);
  }
  public class Snapshot { public string Id; public int FormFactor; public long Revision; }
}
'@
$voiceWatcher = [VoiceOutput.Watcher]::new()
try {
  $voiceRevision = -1L
  do {
    if ($voiceWatcher.Revision -ne $voiceRevision) {
      $voiceSnapshot = $voiceWatcher.Read()
      $voiceRevision = $voiceSnapshot.Revision
      $voiceEndpoint = if ($null -ne $voiceSnapshot.Id) { @{id=$voiceSnapshot.Id;formFactor=$voiceSnapshot.FormFactor;revision=$voiceRevision} } else { $null }
      @{endpoint=$voiceEndpoint;revision=$voiceRevision} | ConvertTo-Json -Compress
    }
    if (-not $Once) { Start-Sleep -Milliseconds 30 }
  } while (-not $Once)
} finally { $voiceWatcher.Dispose() }
