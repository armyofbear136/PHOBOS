$f = [System.IO.File]::OpenRead("C:\Users\armyo\.phobos\models\image\sdxl\RealVisXL_V5.0-Q4_0.gguf")
$r = [System.IO.BinaryReader]::new($f)
$r.ReadBytes(4) | Out-Null   # magic
$r.ReadUInt32() | Out-Null   # version
$tensorCount = $r.ReadUInt64()
$metaCount = $r.ReadUInt64()
"Tensors: $tensorCount  Meta: $metaCount"

# Skip all metadata — read each KV pair type and skip its value
for ($i = 0; $i -lt $metaCount; $i++) {
    $kl = $r.ReadUInt64(); $r.ReadBytes($kl) | Out-Null
    $vt = $r.ReadUInt32()
    switch ($vt) {
        7  { $r.ReadByte() | Out-Null }
        0  { $r.ReadByte() | Out-Null }
        1  { $r.ReadSByte() | Out-Null }
        2  { $r.ReadUInt16() | Out-Null }
        3  { $r.ReadInt16() | Out-Null }
        4  { $r.ReadUInt32() | Out-Null }
        5  { $r.ReadInt32() | Out-Null }
        6  { $r.ReadSingle() | Out-Null }
        10 { $r.ReadUInt64() | Out-Null }
        11 { $r.ReadInt64() | Out-Null }
        12 { $r.ReadDouble() | Out-Null }
        8  { $vl = $r.ReadUInt64(); $r.ReadBytes($vl) | Out-Null }
        9  { $at = $r.ReadUInt32(); $ac = $r.ReadUInt64()
             $sz = switch($at){0{1}1{1}2{2}3{2}4{4}5{4}6{4}7{1}10{8}11{8}12{8}default{0}}
             if ($sz -gt 0) { $r.ReadBytes($ac * $sz) | Out-Null } else { break } }
    }
}

"--- tensor names ---"
for ($i = 0; $i -lt [Math]::Min($tensorCount, 10); $i++) {
    $nl = $r.ReadUInt32(); $name = [System.Text.Encoding]::UTF8.GetString($r.ReadBytes($nl))
    $dims = $r.ReadUInt32()
    for ($d = 0; $d -lt $dims; $d++) { $r.ReadUInt64() | Out-Null }
    $r.ReadUInt32() | Out-Null  # type
    $r.ReadUInt64() | Out-Null  # offset
    $name
}
$f.Close()