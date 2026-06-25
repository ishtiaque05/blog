---
title: "WiFi Capped at 20 Mbps on a ThinkPad P16v — Three Kernel Bugs Later"
description: "A four-hour kernel debugging session on a Qualcomm WCN6855 adapter that uncovered three stacked bugs: a Lenovo SMBIOS lie, a Static SMPS default, and an AP that demanded ten spatial streams."
date: 2026-06-25
tags: ["linux", "kernel", "wifi", "debugging"]
---

My ThinkPad P16v Gen 1 connected to a WiFi 6 router but refused to go faster than about 20 Mbps. The signal was excellent (-39 dBm), the router was a capable WiFi 6 AP advertising 1170 Mbit/s, and the adapter — a Qualcomm QCNFA765 / WCN6855 hw2.1 — was supposed to be a proper WiFi 6 card. Yet `iw dev wlp2s0 link` kept reporting a 54 Mbps legacy rate.

```
┌─[ wlp2s0 ]───────────────────────────────────────────┐
│ adapter   Qualcomm QCNFA765 / WCN6855 hw2.1           │
│ signal    -39 dBm                          excellent  │
│ link      54 Mbit/s   20 MHz (no HT)       [ BROKEN ] │
│ expected  1200 Mbit/s 80 MHz HE 2x2        [ WiFi 6 ] │
└───────────────────────────────────────────────────────┘
```

What followed was a four-hour debugging session that uncovered three separate kernel bugs stacked on top of each other. All three had to be fixed before the card would operate correctly.

---

## The Symptom

```
channel 44 (5220 MHz), width: 20 MHz (no HT), center1: 5220 MHz
```

`(no HT)` is the critical phrase. HT stands for High Throughput — 802.11n. Without it, the adapter falls back to legacy 802.11a mode, which tops out at 54 Mbps link rate and around 20 Mbps real throughput. The adapter is supposed to connect in HE (High Efficiency, 802.11ax / WiFi 6) mode at 80 MHz wide, giving hundreds of Mbps.

mac80211 negotiates the best mode it can and degrades when something fails. We were pinned at the very bottom of that ladder:

```
 MODE     LINK RATE                                   STATUS
 ───────  ──────────────────────────────────────────  ────────────────
 HE80     ~1200 Mbit/s  ████████████████████████████  ← target (WiFi 6)
 VHT80     ~866 Mbit/s  ████████████████████
 HT40      ~300 Mbit/s  ███████
 LEGACY     ~54 Mbit/s  █                              ← stuck here
```

The kernel was telling us exactly what went wrong:

```
wlp2s0: required MCSes not supported, disabling HT
```

MCS stands for Modulation and Coding Scheme — the table of data rates that 802.11n/ac/ax devices negotiate. This message means mac80211 (the kernel's WiFi stack) decided our adapter couldn't satisfy the AP's minimum rate requirements, so it disabled HT entirely and fell back to legacy.

---

## Understanding the Stack

The Linux WiFi stack has two main layers relevant here:

- **`ath11k`** — the hardware driver for Qualcomm 802.11ax chips. It talks to the firmware over PCIe, loads calibration data from firmware files, and tells mac80211 what the hardware can do.
- **`mac80211`** — the generic 802.11 protocol layer. It handles the connection negotiation, decides what modes and rates to use, and manages the actual 802.11 state machine.

```
                  ┌────────────────────────┐
                  │   Access Point (AP)    │
                  └───────────┬────────────┘
                              │  802.11 over the air
        ╔═════════════════════╪════════════════════════════╗
        ║   LINUX HOST        │                            ║
        ║          ┌──────────┴───────────┐                ║
        ║          │      mac80211        │  negotiation,  ║
        ║          │  generic 802.11 MLME │  mode + rate   ║   ← Bug 3
        ║          ├──────────────────────┤                ║
        ║          │       ath11k         │  capabilities, ║
        ║          │  PCIe hardware driver│  board lookup  ║   ← Bug 1, 2
        ║          ├──────────────────────┤                ║
        ║          │   WCN6855 firmware   │  RF cal from   ║
        ║          │   + board-2.bin      │  board file    ║
        ║          └──────────────────────┘                ║
        ╚═══════════════════════════════════════════════════╝
```

When you connect to an AP, mac80211 reads the AP's advertised capabilities, compares them against what the driver registered, and decides the best connection mode. If something in this negotiation fails, it degrades — from HE to VHT to HT to LEGACY. As it turned out, one bug lived at each level of this stack.

---

## Initial Investigation

The first useful command is always the kernel log:

```bash
sudo dmesg | grep -E "ath11k|wlp2s0" | tail -30
```

This showed:

```
ath11k_pci 0000:02:00.0: board_id 255
wlp2s0: required MCSes not supported, disabling HT
```

`board_id 255` (hex `0xFF`) is the ath11k equivalent of "I have no idea what card this is, using generic defaults." The firmware reports this when it can't find a specific calibration entry for the hardware.

Every ath11k device loads a `board-2.bin` file — a database of calibration blobs indexed by identifiers like the PCI subsystem vendor/device ID. The driver builds a lookup key and extracts the matching calibration data. If the lookup finds only the generic fallback entry, the firmware runs with factory-default RF parameters that may be wrong for the specific PCB design.

Checking what entries existed for our hardware:

```bash
zstdcat /lib/firmware/ath11k/WCN6855/hw2.1/board-2.bin.zst | strings | grep "17aa:9309"
```

`17aa:9309` is our subsystem IDs (Lenovo ThinkPad subsystem vendor + device). This showed several variant entries:

```
bus=pci,vendor=17aa,device=9309,subsystem-vendor=17aa,subsystem-device=9309,qmi-chip-id=18,qmi-board-id=255,variant=le_lfr-1
bus=pci,vendor=17aa,device=9309,subsystem-vendor=17aa,subsystem-device=9309,qmi-chip-id=18,qmi-board-id=255,variant=LE_NDA-M
bus=pci,vendor=17aa,device=9309,subsystem-vendor=17aa,subsystem-device=9309,qmi-chip-id=18,qmi-board-id=255,variant=LE_NDA-P
bus=pci,vendor=17aa,device=9309,subsystem-vendor=17aa,subsystem-device=9309,qmi-chip-id=18,qmi-board-id=255,variant=LEmm
```

Four variants exist — `le_lfr-1`, `LE_NDA-M`, `LE_NDA-P`, `LEmm` — each with proper calibration data for different ThinkPad models using this chip. But the driver was matching none of them. The key to picking a variant is a `variant=` field in the lookup key, which comes from a string called `bdf_ext`.

```
  lookup key the driver builds:
    bus=pci,vendor=17aa,...,qmi-board-id=255  [, variant=???? ]
                                                          ▲
                                                          └─ empty → matches
                                                             only the generic
                                                             0xFF entry
```

---

## The Obvious Things That Didn't Work

Before reaching for a compiler, every standard fix was worth trying.

### Reconnect and regulatory domain

The first instinct was to force a reconnect in case it was a transient negotiation failure:

```bash
nmcli connection down "G2 1" && nmcli connection up "G2 1"
```

Same result. `iw dev wlp2s0 info` still showed `width: 20 MHz (no HT)`.

The second instinct was regulatory domain. WiFi channels and power limits are regulated by country, and a wrong regulatory domain can prevent the driver from using certain channels or widths. Ubuntu defaults to a permissive world regulatory domain (`00`):

```bash
iw reg get
```

```
global
country 00: DFS-UNSET
    ...
```

Setting it to Canada (where the AP is configured for):

```bash
sudo iw reg set CA
iw reg get
```

```
global
country CA: DFS-JP
    ...
phy#0
country 99: DFS-UNSET
```

The `phy#0` section still said `country 99: DFS-UNSET`. This is because the WCN6855 is a **self-managed regulatory domain** device — it manages its own regulatory table in firmware and ignores the global kernel setting. `iw reg set` has no effect on it.

### Power save off

Power save mode can throttle throughput on some drivers. Disabling it:

```bash
sudo iw dev wlp2s0 set power_save off
iw dev wlp2s0 get power_save
# Power save: off
```

Still `20 MHz (no HT)`. Power save wasn't the issue.

### Driver reload

Maybe the driver was in a bad state from boot. Unloading and reloading:

```bash
sudo modprobe -r ath11k_pci && sudo modprobe ath11k_pci
sudo dmesg | grep board_id | tail -3
```

```
ath11k_pci 0000:02:00.0: board_id 255
```

`board_id 255` persisted through reloads. The state was coming from the firmware/board files, not from runtime state.

### modprobe options

The ath11k driver has two parameters relevant to performance:

```bash
# cold_boot_cal=1 forces re-calibration on every cold boot (default on some platforms)
# frame_mode=2 enables native WiFi frame mode instead of ethernet-encapsulated
sudo bash -c 'cat > /etc/modprobe.d/ath11k.conf << EOF
options ath11k cold_boot_cal=0
options ath11k frame_mode=2
EOF'

sudo modprobe -r ath11k_pci && sudo modprobe ath11k_pci
```

`cold_boot_cal=0` prevents a calibration delay on each boot. `frame_mode=2` tells the driver to use native 802.11 frames internally, which can improve throughput on some configurations. Neither fixed the `(no HT)` problem, but both are sensible settings to keep. (`cold_boot_cal=0` comes back to haunt us in the bonus round.)

### Reinstalling firmware

Maybe the firmware files on disk were corrupted or outdated. Ubuntu ships WiFi firmware through the `linux-firmware` package:

```bash
sudo apt install --reinstall linux-firmware
sudo modprobe -r ath11k_pci && sudo modprobe ath11k_pci
```

Same result. The firmware package was current (`20260319.git217ca6e4.1ubuntu`) and intact.

### Swapping in the NFA765-specific firmware

Digging into the firmware directory revealed something interesting:

```
/lib/firmware/ath11k/WCN6855/hw2.0/
├── amss.bin.zst       ← 1.9 MB generic firmware
├── board-2.bin.zst
├── m3.bin.zst
└── nfa765/
    ├── amss.bin.zst   ← 2.0 MB NFA765-specific firmware
    └── m3.bin.zst
```

The package ships a larger, model-specific firmware (`nfa765/amss.bin`) but nothing was pointing to it. The main `amss.bin` was the generic version. Forcing the NFA765 firmware:

```bash
sudo cp /lib/firmware/ath11k/WCN6855/hw2.0/amss.bin.zst \
        /lib/firmware/ath11k/WCN6855/hw2.0/amss.bin.zst.generic.bak
sudo cp /lib/firmware/ath11k/WCN6855/hw2.0/nfa765/amss.bin.zst \
        /lib/firmware/ath11k/WCN6855/hw2.0/amss.bin.zst
sudo modprobe -r ath11k_pci && sudo modprobe ath11k_pci
```

dmesg showed the newer firmware loaded (build date changed from 2024-04-17 to 2025-05-10, TX power shifted from 15 dBm to 13 dBm), but `board_id 255` persisted. The firmware variant affects radio behaviour but the board calibration lookup happens separately — the firmware still couldn't find its calibration data.

Reverted this change since it wasn't the root problem.

### Removing board-2.bin entirely

If the board file was giving bad calibration data, maybe removing it would force the firmware to use built-in defaults:

```bash
sudo mv /lib/firmware/ath11k/WCN6855/hw2.1/board-2.bin.zst \
        /lib/firmware/ath11k/WCN6855/hw2.1/board-2.bin.zst.disabled
sudo modprobe -r ath11k_pci && sudo modprobe ath11k_pci
```

WiFi disappeared entirely. The interface came up but could not associate with anything. `dmesg` showed the firmware failing to initialise without the board data. Reverted immediately.

```bash
sudo mv /lib/firmware/ath11k/WCN6855/hw2.1/board-2.bin.zst.disabled \
        /lib/firmware/ath11k/WCN6855/hw2.1/board-2.bin.zst
```

### Fetching upstream board-2.bin from git

The Ubuntu `linux-firmware` package is updated on its own schedule. The upstream `linux-firmware` git repository at `git.kernel.org` might have a newer `board-2.bin` with a corrected entry for this hardware:

```bash
git clone --depth=1 --filter=blob:none --sparse \
  https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git \
  /tmp/linux-firmware-git

cd /tmp/linux-firmware-git
git sparse-checkout set ath11k/WCN6855

zstdcat ath11k/WCN6855/hw2.1/board-2.bin.zst | strings | grep "17aa.*9309" | wc -l
```

Same 4 entries as the Ubuntu package. The upstream board-2.bin was no newer for our hardware. Also, the upstream firmware targeted `hw2.0` and was incompatible with our `hw2.1` silicon — installing it broke WiFi completely.

### Taking stock

After all of this, the situation was:

```
  [✓] reconnect / nmcli            → 20 MHz (no HT)
  [✓] regulatory domain CA         → ignored (self-managed)
  [✓] power_save off               → 20 MHz (no HT)
  [✓] driver reload                → board_id 255 persists
  [✓] modprobe options             → 20 MHz (no HT)
  [✓] reinstall linux-firmware     → 20 MHz (no HT)
  [✓] NFA765-specific amss.bin     → board_id 255 persists
  [✓] remove board-2.bin           → WiFi dead, reverted
  [✓] upstream board-2.bin (git)   → same 4 entries / incompatible
  ─────────────────────────────────────────────────────────────
  root cause: driver selects NO variant → generic broken entry
```

The problem had to be in how the driver picks its variant. Time to read the source.

---

## Bug 1: The Lenovo SMBIOS Lie

The `bdf_ext` (board data file extension) string is populated in `ath11k_core_check_smbios()` in `drivers/net/wireless/ath/ath11k/core.c`. It reads a custom SMBIOS table entry — type `0xF8` — that Lenovo puts in the laptop's firmware to tell the driver which variant to use.

The SMBIOS type `0xF8` struct looks like this:

```c
struct ath11k_smbios_bdf {
    struct dmi_header hdr;
    u8 features_disabled;
    u8 country_code_flag;
    u16 cc_code;
    u8 bdf_enabled;     // 1 = "use the variant string below"
    u8 bdf_ext[];       // the actual variant string
};
```

Reading this with `dmidecode`:

```bash
sudo dmidecode --type 248
```

Output:

```
Handle 0x0056, DMI type 248, 10 bytes
OEM-specific Type
    Header and Data:
        F8 0A 56 00 00 00 00 00 01 00
```

Decoding the bytes: `bdf_enabled = 0x01` (the flag says "yes, use a variant string"), but the byte immediately after — where `bdf_ext[]` should be — is `0x00`. The string is empty.

```
  F8   0A   56 00   00 00 00 00   01   00
  │    │    │       │             │    └─ bdf_ext[0] = 0x00   ← EMPTY string
  │    │    │       │             └────── bdf_enabled = 1     "use a variant!"
  │    │    │       └──────────────────── cc_code / flags
  │    │    └──────────────────────────── handle
  │    └───────────────────────────────── length = 10
  └────────────────────────────────────── type 0xF8 (248)

  contradiction: "use a variant" + "(no variant provided)"
```

The driver's check for the variant string is:

```c
if (memcmp(smbios->bdf_ext, "BDF_", 4) == 0)
    /* copy the string */
```

An empty `bdf_ext[]` can't match `"BDF_"`, so the check fails, `bdf_ext` stays empty, the `variant=` field is never added to the lookup key, and we match only the generic entry.

This is a Lenovo firmware bug: the laptop claims it has a variant string but doesn't provide one.

**The fix:** If `bdf_ext` is empty after the SMBIOS walk, fall back to checking `DMI_PRODUCT_NAME`. Our machine reports `21FE001WUS`, and `21FE` is the ThinkPad P16v Gen 1 model prefix. Hard-code the correct variant:

```c
int ath11k_core_check_smbios(struct ath11k_base *ab)
{
    const char *prod;

    ab->qmi.target.bdf_ext[0] = '\0';
    dmi_walk(ath11k_core_check_cc_code_bdfext, ab);

    if (ab->qmi.target.bdf_ext[0] == '\0') {
        /*
         * DMI fallback: Lenovo P16v Gen 1 has bdf_enabled=1 in SMBIOS
         * type 0xF8 but an empty bdf_ext[] string — the flag says "use a
         * variant" but doesn't say which one. Fall back to product name.
         */
        prod = dmi_get_system_info(DMI_PRODUCT_NAME);
        if (prod && strncmp(prod, "21FE", 4) == 0) {
            strscpy(ab->qmi.target.bdf_ext, "LEmm",
                    sizeof(ab->qmi.target.bdf_ext));
            ath11k_info(ab,
                        "DMI fallback: bdf_ext=LEmm (ThinkPad P16v Gen 1, prod=%s)\n",
                        prod);
        }
    }

    if (ab->qmi.target.bdf_ext[0] == '\0')
        return -ENODATA;

    return 0;
}
```

`strncmp(prod, "21FE", 4)` matches any `21FE` model (P16v Gen 1 has several SKUs, all starting with `21FE`). `strscpy` is the kernel's safe string copy that guarantees null-termination.

`ath11k_info()` routes through `dev_info()` and is visible in `dmesg` without any special debug flags — useful for verifying the patch loaded.

After rebuilding and installing this patch:

```
ath11k_pci 0000:02:00.0: DMI fallback: bdf_ext=LEmm (ThinkPad P16v Gen 1, prod=21FE001WUS)
```

The correct board file loaded. Chain mask changed to `0x3` (2 antennas active) and `iw phy phy0 info` reported `HT TX/RX MCS rate indexes supported: 0-15` — both streams, MCS 0 through 15. Progress. But the "required MCSes" error persisted.

---

## Bug 2: The Adapter Was Pretending to Have One Antenna

With the correct board file, the driver had 2 RX chains. But checking the HT capabilities:

```bash
iw phy phy0 info | grep -A 10 "Band 2"
```

```
Capabilities: 0x19e3
    ...
    Static SM Power Save
    ...
HT TX/RX MCS rate indexes supported: 0-15
```

`Static SM Power Save` (SMPS) is the problem. Spatial Multiplexing Power Save is a mechanism in 802.11n where a device can tell the AP "I can only receive one spatial stream right now, send me single-stream MCS (0-7) to save power." **Static** SMPS means this restriction is permanent for the session.

From the AP's perspective, a station announcing Static SMPS might as well have one antenna. It won't send MCS 8-15 (2-stream rates) even though the station is physically capable of receiving them.

```
  physical reality          what the AP was told
  ┌──────────────┐          ┌──────────────┐
  │  ((( A1 )))  │          │  ((( A1 )))  │
  │  ((( A2 )))  │   ──►     │      ▒▒      │  Static SMPS =
  │   2 chains   │          │  "1 stream"  │  "ignore antenna 2"
  └──────────────┘          └──────────────┘
   capable of MCS 8-15       AP only sends MCS 0-7
```

The relevant code is in `ath11k_create_ht_cap()` in `drivers/net/wireless/ath/ath11k/mac.c`:

```c
if (ar_ht_cap & WMI_HT_CAP_DYNAMIC_SMPS) {
    u32 smps;
    smps   = WLAN_HT_CAP_SM_PS_DYNAMIC;
    smps <<= IEEE80211_HT_CAP_SM_PS_SHIFT;
    ht_cap.cap |= smps;
}
/* else: nothing — bits 2-3 stay 00 = Static SMPS */
```

The HT capability bits 2-3 encode the SMPS mode:

```
  HT cap bits [3:2]   meaning
  ─────────────────   ────────────────────────────────────────
       0 0            Static SMPS    1 stream only, permanently  ← our default
       0 1            Dynamic SMPS   1 stream, switchable via RTS/CTS
       1 1            SMPS Disabled  full multi-stream operation  ← what we want
```

The driver only sets SMPS Disabled when the firmware explicitly reports `WMI_HT_CAP_DYNAMIC_SMPS`. Our firmware doesn't advertise this flag, so the else branch runs — which does nothing, leaving bits 2-3 as `00` (Static SMPS).

**The fix:** When the firmware doesn't report Dynamic SMPS but the hardware has more than one RX chain, default to SMPS Disabled. There's no reason to restrict a multi-antenna card to single-stream.

```c
if (ar_ht_cap & WMI_HT_CAP_DYNAMIC_SMPS) {
    u32 smps;
    smps   = WLAN_HT_CAP_SM_PS_DYNAMIC;
    smps <<= IEEE80211_HT_CAP_SM_PS_SHIFT;
    ht_cap.cap |= smps;
} else if (ar->num_rx_chains > 1) {
    /*
     * Firmware doesn't advertise Dynamic SMPS but the hardware has
     * multiple RX chains. Default to SMPS Disabled so the AP knows
     * it can send multi-stream frames (MCS 8-15 for 2 chains).
     */
    ht_cap.cap &= ~IEEE80211_HT_CAP_SM_PS;
    ht_cap.cap |= WLAN_HT_CAP_SM_PS_DISABLED << IEEE80211_HT_CAP_SM_PS_SHIFT;
}
```

`IEEE80211_HT_CAP_SM_PS` is the 2-bit mask for bits 2-3. We clear those bits first, then OR in `WLAN_HT_CAP_SM_PS_DISABLED` (value `3`, binary `11`) shifted to the right position.

After this patch, `iw phy phy0 info` reported:

```
Capabilities: 0x19ef
    SM Power Save disabled
HT TX/RX MCS rate indexes supported: 0-15
```

Correct. But "required MCSes not supported, disabling HT" still appeared.

---

## Bug 3: The AP Was Lying About Its Requirements

With the driver fixed, it was time to look at mac80211. The message `required MCSes not supported, disabling HT` comes from `ieee80211_determine_chan_mode()` in `net/mac80211/mlme.c`:

```c
if (conn->mode >= IEEE80211_CONN_MODE_HT &&
    !ieee80211_verify_sta_ht_mcs_support(sdata, sband,
                                         elems->ht_operation)) {
    conn->mode = IEEE80211_CONN_MODE_LEGACY;
    conn->bw_limit = IEEE80211_CONN_BW_LIMIT_20;
    link_id_info(sdata, link_id,
                 "required MCSes not supported, disabling HT\n");
}
```

When `ieee80211_verify_sta_ht_mcs_support()` returns false, mac80211 downgrades the connection mode all the way to LEGACY (802.11a/g) — no HT, no VHT, no HE. And it stays there.

The function checks whether our adapter's RX MCS mask satisfies the AP's "basic MCS set" — the minimum rates every station in the BSS must support:

```c
static bool
ieee80211_verify_sta_ht_mcs_support(struct ieee80211_sub_if_data *sdata,
                                    struct ieee80211_supported_band *sband,
                                    const struct ieee80211_ht_operation *ht_op)
{
    struct ieee80211_sta_ht_cap sta_ht_cap;
    int i;

    if (sband->band == NL80211_BAND_6GHZ)
        return true;

    if (!ht_op)
        return false;   // original code — fails if no HT Operation IE

    memcpy(&sta_ht_cap, &sband->ht_cap, sizeof(sta_ht_cap));
    ieee80211_apply_htcap_overrides(sdata, &sta_ht_cap);

    for (i = 0; i < IEEE80211_HT_MCS_MASK_LEN; i++) {
        if ((ht_op->basic_set[i] & sta_ht_cap.mcs.rx_mask[i]) !=
            ht_op->basic_set[i])
            return false;
    }

    return true;
}
```

`IEEE80211_HT_MCS_MASK_LEN` is 10. The loop checks all 10 bytes of the AP's `basic_set` against our `rx_mask`. If any bit in `basic_set` is set but missing from `rx_mask`, the function returns false.

I added a diagnostic print to see the actual values:

```c
sdata_info(sdata,
    "HT MCS check: basic_set=%*phN rx_mask=%*phN\n",
    (int)IEEE80211_HT_MCS_MASK_LEN, ht_op->basic_set,
    (int)IEEE80211_HT_MCS_MASK_LEN, sta_ht_cap.mcs.rx_mask);
```

`%*phN` is the kernel's format specifier for printing a byte array as hex without separators. The `*` takes the length as the first argument.

After rebuilding and reloading, dmesg revealed:

```
wlp2s0: HT MCS check: basic_set=ffffffffffffffffffff rx_mask=ffff0000000000000000
```

Lining the two byte arrays up against what each byte *means* makes the bug obvious:

```
  byte index   0    1    2    3    4    5    6    7    8    9
  stream       1    2    3    4    5    6    7    8    9   10
  MCS range   0-7  8-15 ...
             ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
  AP basic   │ FF │ FF │ FF │ FF │ FF │ FF │ FF │ FF │ FF │ FF │  "I require
             └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘   10 streams"
             ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
  our rx     │ FF │ FF │ 00 │ 00 │ 00 │ 00 │ 00 │ 00 │ 00 │ 00 │  "I have
             └────┴────┴──┬─┴────┴────┴────┴────┴────┴────┴────┘   2 streams"
                          ▲
                          └─ (FF & 00) != FF  → check fails → HT disabled
```

The AP's `basic_set` is `ff ff ff ff ff ff ff ff ff ff` — **all 10 bytes set to 0xFF**. This means the AP is claiming it requires MCS indices 0 through 79, which would need up to 10 spatial streams. No real device has 10 spatial streams. This is a firmware bug in the AP.

Our `rx_mask` is `ff ff 00 00 00 00 00 00 00 00` — bytes 0 and 1 are `0xFF` (MCS 0-15, our two streams), bytes 2-9 are zero. The check fails starting at byte 2: `(0xFF & 0x00) != 0xFF`.

No AP has a legitimate reason to require 3+ spatial streams as a *basic* rate. Basic rates are supposed to be the minimum every client must support to join the network — in practice usually just MCS 0-7 (1-stream).

**The fix:** Limit the check to bytes 0 and 1 (MCS 0-15). This covers every legitimate basic-rate requirement and ignores the AP's bogus 3-10 stream claims:

```c
/*
 * Many APs set basic_set=0xFF for all 10 bytes — claiming MCS rates
 * up to 10 spatial streams, which no STA can provide.  Only verify
 * bytes 0-1 (MCS 0-15, 1-2 streams): the only range where a basic-rate
 * requirement is meaningful.
 */
for (i = 0; i < 2; i++) {
    if ((ht_op->basic_set[i] & sta_ht_cap.mcs.rx_mask[i]) !=
        ht_op->basic_set[i])
        return false;
}
```

Also fixed the `!ht_op` path while here. The original code returned `false` if there was no HT Operation IE — meaning WiFi 6 APs that operate in HE-only mode and omit the legacy HT Operation IE would trigger the same downgrade. Changed to return `true` (no HT Operation IE means no HT basic-rate requirement):

```c
if (!ht_op)
    return true; /* no HT Operation IE = no basic MCS requirement */
```

---

## Building the Patched Modules

The Ubuntu kernel ships modules as `.ko.zst` files (zstd-compressed). Patching them requires:

1. Installing the kernel source and headers
2. Extracting and patching the relevant source directories
3. Building as out-of-tree modules
4. Compressing and installing

```bash
sudo apt install build-essential linux-headers-$(uname -r) linux-source-$(uname -r | cut -d- -f1) zstd
```

Out-of-tree builds use the kernel's build system pointed at a directory of source:

```bash
make -C /lib/modules/$(uname -r)/build M=/path/to/ath11k modules
```

`-C /lib/modules/$(uname -r)/build` sets the kernel build directory (where headers, scripts, and config live). `M=` points to the module source. The build system uses the kernel's `Makefile` and `Kconfig`, so it picks up the right compiler flags and symbol versions automatically.

One build error worth noting: ath11k's `spectral.h` includes `"../spectral_common.h"` (a file in the parent `ath/` directory). Since we're building out-of-tree with just the `ath11k/` directory, this parent file is missing. Fix by extracting it separately:

```bash
tar -xf /usr/src/linux-source-7.0.0.tar.bz2 \
    --strip-components=4 \
    -C /path/to/ath/parent/ \
    linux-source-7.0.0/drivers/net/wireless/ath/spectral_common.h
```

After building, compress to match what the kernel expects:

```bash
zstd -19 -f ath11k.ko -o ath11k.ko.zst
```

`-19` is the maximum compression level — matches what Ubuntu's kernel build uses.

Back up the originals before installing:

```bash
sudo cp /lib/modules/$(uname -r)/kernel/.../ath11k.ko.zst \
        /lib/modules/$(uname -r)/kernel/.../ath11k.ko.zst.bak
sudo cp /tmp/ath11k.ko.zst \
        /lib/modules/$(uname -r)/kernel/.../ath11k.ko.zst
```

Reload without rebooting:

```bash
sudo modprobe -r ath11k_pci ath11k mac80211
sudo modprobe ath11k_pci
```

`modprobe -r` unloads in dependency order (ath11k_pci depends on ath11k, which depends on mac80211). `modprobe ath11k_pci` loads the stack in the correct order automatically.

---

## The Result

After all three patches:

```bash
$ iw dev wlp2s0 info | grep channel
    channel 44 (5220 MHz), width: 80 MHz, center1: 5210 MHz
```

`80 MHz` — VHT80/HE80, 2×2 MIMO. From `20 MHz (no HT)` to WiFi 6 in one session.

```
  before  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  20 Mbit/s   20 MHz (no HT)
  after   ████████████████████████████  1200 Mbit/s 80 MHz HE 2x2
          └─────────────── 60x ───────────────┘
```

```bash
$ sudo dmesg | grep "DMI fallback"
ath11k_pci 0000:02:00.0: DMI fallback: bdf_ext=LEmm (ThinkPad P16v Gen 1, prod=21FE001WUS)

$ sudo dmesg | grep "disabling HT"
(nothing)
```

---

## Why Three Bugs?

Each bug was a blocker that masked the next one. You couldn't even *see* the second problem until the first was fixed:

```
  symptom: 20 Mbps, width 20 MHz (no HT)
       │
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Bug 1  Lenovo SMBIOS lie (firmware)                          │
  │        empty bdf_ext → wrong board file → 1-stream cap       │
  │        ──────────────────────────────────────────────►      │ masks ▼
  │  ┌──────────────────────────────────────────────────────┐   │
  │  │ Bug 2  Static SMPS default (ath11k driver)            │   │
  │  │        AP thinks the card has one antenna             │   │
  │  │        ─────────────────────────────────────────►    │   │ masks ▼
  │  │  ┌────────────────────────────────────────────────┐  │   │
  │  │  │ Bug 3  AP basic_set = 0xFF x10 (mac80211)       │  │   │
  │  │  │        mac80211 kills HT entirely → LEGACY      │  │   │
  │  │  └────────────────────────────────────────────────┘  │   │
  │  └──────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘
       three independent bugs, stacked into one total failure
```

- Without Bug 1 fixed, the wrong board file loaded → wrong chain masks → 1-stream capability → the driver never got to SMPS
- Without Bug 2 fixed, SMPS was Static → AP assumed 1-stream → multi-stream rates were theoretical but unused
- Without Bug 3 fixed, mac80211 rejected the connection in HT mode entirely regardless of what the driver reported

They were independent bugs — a Lenovo firmware issue, an ath11k driver oversight, and an AP firmware quirk that mac80211 was too strict about — that happened to stack into a complete failure.

---

## The Fixes Are Upstream-Worthy

All three patches are legitimate kernel bug fixes:

**Patch 1 (ath11k/core.c)** — The `BDF_`-prefix check in `ath11k_core_check_cc_code_bdfext` should probably handle the `bdf_enabled=1` + empty string case more gracefully, or the DMI fallback for known-broken Lenovo models should be added to the driver. The ThinkPad P16v Gen 1 (`21FE`) is the same class of device as the `21F8`, `21J3`, etc. models that already have DMI workarounds in the driver.

**Patch 2 (ath11k/mac.c)** — Defaulting to Static SMPS when `num_rx_chains > 1` and the firmware provides no SMPS guidance is incorrect. SMPS Disabled is the right default for a multi-antenna device that isn't trying to save power.

**Patch 3 (mac80211/mlme.c)** — The 10-byte basic_set check assumes APs only set basic-rate bits for rates they actually require, but real AP firmware often sets the entire field. Limiting the check to bytes 0-1 (single and dual-stream MCS, the only rates any AP could reasonably mandate as basic) would avoid false positives without violating the spec in any meaningful way.

```
  machine    Lenovo ThinkPad P16v Gen 1 (21FE001WUS)
  adapter    Qualcomm QCNFA765 / WCN6855 hw2.1
  kernel     7.0.0-22-generic
  driver     ath11k_pci
```

---

## Bonus Round: 50 Mbps After Every Reboot

Three bugs fixed. WiFi connecting at 1200 Mbps over 80 MHz. Job done, right?

Then I rebooted.

```
fast.com: 50 Mbps
```

The phone sitting next to the laptop, on the same WiFi, showed 500+ Mbps. The WiFi link still showed 1200 Mbps in `iw dev wlp2s0 link`. Everything looked fine — but actual throughput was capped at 50 Mbps, exactly one-tenth of what it should be.

And here's the maddening part: running the same module reload command that was used during the debugging session immediately fixed it:

```bash
sudo modprobe -r ath11k_pci ath11k mac80211 && sudo modprobe ath11k_pci
```

After that, 500+ Mbps. Reboot again, back to 50 Mbps.

---

### The Wrong Suspect: cold_boot_cal

Remember the modprobe options added early in the debugging process that did nothing?

```
/etc/modprobe.d/ath11k.conf:
options ath11k cold_boot_cal=0
options ath11k frame_mode=2
```

`cold_boot_cal=0` disables cold boot calibration. The parameter description says: "Decrease the channel switch time but increase the driver load time (Default: true)." In other words, the default (`true`) does a full calibration at cold boot, which takes longer but is more accurate. Setting it to `0` skips calibration for a faster boot.

This was the obvious suspect. Remove it, let calibration run on cold boot, problem solved — right?

Removed it. Rebooted. Still 50 Mbps.

`cold_boot_cal=0` wasn't the culprit for the throughput cap. It was just a red herring leftover from the early failed experiments that had never been cleaned up.

---

### What's Actually Different

Think of the WiFi card like a musician who just woke up from a deep sleep and walked straight onto stage.

They know all the notes. Their instrument is technically in tune. But cold muscles, foggy brain, fingers that haven't warmed up — the performance is stiff and choppy. The audience can tell something's off even if they can't name it.

Now imagine someone pauses the show for 30 seconds, the musician does some quick warm-up exercises, and then plays the same piece. Suddenly it sounds great.

That's what's happening here. After a cold power-up:

1. The PCIe device goes through its entire power-on sequence for the first time
2. The firmware loads, does its initialization
3. The driver loads on top of that

Everything is technically correct. The link shows 1200 Mbps. But deep in the firmware's RF calibration state, something is slightly off — the radio is "cold." The card can receive and send frames, but at a degraded rate that causes lots of silent retransmissions at the WiFi MAC layer. TCP sees these as dropped packets, thinks the network is congested, and throttles itself to 50 Mbps.

When the modules are reloaded a few minutes later (after the system has been running, PCIe has had some traffic, the hardware is warm), the firmware initializes into a better state. The retransmissions drop. TCP sees a clean connection and ramps up to full speed.

The key word is "later." The systemd service installed as the first fix ran the module reload 5 seconds after boot — the hardware was still cold. The manual reload done 5-10 minutes after boot worked because by then everything had settled.

---

### Why the Link Rate Is Fine but Throughput Isn't

This confused me for a while. `iw dev wlp2s0 link` showed:

```
rx bitrate: 1200.9 MBit/s 80MHz HE-MCS 11 HE-NSS 2
```

How can the WiFi link be at 1200 Mbps but TCP only deliver 50 Mbps?

The 1200 Mbps is the **PHY rate** — the speed at which the radio modulates individual frames. It's like a highway's posted speed limit. Whether cars actually flow at that speed depends on traffic, congestion, and accidents.

```
  PHY rate (posted limit)   1200 Mbit/s  ████████████████████████████
  ────────────────────────────────────────────────────────────────────
  throughput — cold radio     50 Mbit/s  █              silent retries
  throughput — warm radio    500 Mbit/s  ███████████    clean delivery
```

When the firmware is in its cold degraded state, many WiFi frames arrive with errors and have to be retransmitted silently at the MAC layer (invisible to TCP). The PHY rate stays at 1200 Mbps — each individual frame attempt uses MCS 11. But many attempts fail, so the effective throughput is much lower.

TCP eventually sees enough lost packets to think the network is congested. Its congestion window — a limit on how much data it can have "in flight" at once — shrinks. With a 30ms round-trip time and a small congestion window, each TCP connection tops out at around 10-15 Mbps. Multiple parallel connections add up to about 50 Mbps total.

After the warm reload, the frame error rate drops. TCP sees clean delivery, grows its congestion window, and the 1200 Mbps link is actually used.

---

### The Fix: Reload After the First Connect, Not Before

The right approach is to reload the modules *after* the system is up and the hardware has had time to settle — not before NetworkManager even connects.

A **NetworkManager dispatcher script** is perfect for this. These scripts run automatically when the network state changes. When WiFi connects (`wlp2s0` goes "up"), the script fires, waits 10 seconds for the connection to settle, reloads the modules, and NetworkManager reconnects automatically.

```bash
# /etc/NetworkManager/dispatcher.d/99-ath11k-reload
#!/bin/bash

INTERFACE=$1
STATUS=$2
FLAG=/run/ath11k-reloaded-once

[ "$INTERFACE" = "wlp2s0" ] || exit 0
[ "$STATUS" = "up" ] || exit 0
[ ! -f "$FLAG" ] || exit 0   # only once per boot

touch "$FLAG"
sleep 10
modprobe -r ath11k_pci ath11k mac80211
modprobe ath11k_pci
# NetworkManager detects the interface reappear and reconnects
```

The flag file lives in `/run/` which is a tmpfs — it's wiped on every reboot. So the reload happens exactly once per boot: when WiFi first connects.

The sequence after a cold reboot is now:

```
  boot ─► driver loads ─► NM connects ─► [ +10s ] ─► reload ─► reconnect
          (cold/degraded)   ~50 Mbps                 warm     500+ Mbps
                                          dispatcher fires once per boot
          └──────────── one brief WiFi drop ~10s after login ──────────┘
```

1. System boots, driver loads (cold, degraded state)
2. NetworkManager connects to G2 (at ~50 Mbps)
3. ~10 seconds later, dispatcher fires, reloads modules
4. NetworkManager reconnects (at full 500+ Mbps)
5. `/run/ath11k-reloaded-once` flag prevents any further reloads

You'll notice WiFi briefly drop once, about 10 seconds after login. That's the reload happening. After it reconnects, you're at full speed for the rest of the session.

---

### Why Can't We Just Fix the Root Cause?

The honest answer: I don't know exactly why the cold boot leaves the firmware in a degraded RF state. It could be:

- A PCIe link training issue specific to this laptop's PCIe topology
- A firmware bug in how the WCN6855 handles its first-ever power-on calibration
- Something in the ACPI/BIOS power sequencing that puts the PCIe device in a low-power state during boot that the driver doesn't fully recover from
- A race between the PCIe link settling and the driver's initialization sequence

Diagnosing this would require vendor firmware source code or a PCIe protocol analyzer to watch the initialization sequence at the hardware level. Neither is easily accessible for a laptop WiFi card.

The reload workaround is reliable and automatic. The WiFi drop is brief and happens before you'd normally open a browser. For now, it works.
