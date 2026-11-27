//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	k32 = syscall.NewLazyDLL("kernel32.dll")

	pGetSystemTimes       = k32.NewProc("GetSystemTimes")
	pGlobalMemoryStatusEx = k32.NewProc("GlobalMemoryStatusEx")
	pGetDiskFreeSpaceExW  = k32.NewProc("GetDiskFreeSpaceExW")
	pGetTickCount64       = k32.NewProc("GetTickCount64")

	iphlp         = syscall.NewLazyDLL("iphlpapi.dll")
	pGetIfTable2  = iphlp.NewProc("GetIfTable2")
	pFreeMibTable = iphlp.NewProc("FreeMibTable")
)

type filetime struct{ low, high uint32 }
func (f filetime) u64() uint64 { return uint64(f.high)<<32 | uint64(f.low) }

func readCPU() cpuSample {
	var idle, kernel, user filetime
	r, _, _ := pGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if r == 0 {
		return cpuSample{}
	}
	return cpuSample{idle.u64(), kernel.u64() + user.u64()}
}

type memStatusEx struct {
	dwLength, dwMemoryLoad                                 uint32
	ullTotalPhys, ullAvailPhys, ullTotalPage, ullAvailPage uint64
	ullTotalVirt, ullAvailVirt, ullAvailExt                uint64
}

func platformMem() Mem {
	var m memStatusEx
	m.dwLength = uint32(unsafe.Sizeof(m))
	r, _, _ := pGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	if r == 0 {
		return Mem{}
	}
	total, avail := m.ullTotalPhys, m.ullAvailPhys
	used, pct := uint64(0), 0.0
	if total > 0 && total >= avail {
		used = total - avail
		pct = float64(used) / float64(total) * 100
	}
	return Mem{total, used, round1(pct)}
}

func platformDisk(path string) *Disk {
	if path == "" {
		path = `C:\`
	}
	if !strings.HasSuffix(path, "\\") && !strings.HasSuffix(path, "/") {
		path += string(filepath.Separator)
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil
	}
	var free, totalBytes, totalFree uint64
	r, _, _ := pGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&free)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return nil
	}
	used, pct := uint64(0), 0.0
	if totalBytes > 0 && totalBytes >= totalFree {
		used = totalBytes - totalFree
		pct = float64(used) / float64(totalBytes) * 100
	}
	return &Disk{path, totalBytes, used, round1(pct)}
}

type guid struct{ a uint32; b uint16; c uint16; d [8]byte }
type sockaddrInet struct{ data [28]byte }

type mibIfRow2 struct {
	luid           uint64
	interfaceIndex uint32
	_              uint32
	guid           guid
	alias          [257]uint16
	_              [1]uint16
	_              uint32
	inOctets       uint64
	inUcastPkts    uint64
	inNUcastPkts   uint64
	inDiscards     uint64
	inErrors       uint64
	inUnknownProtos uint64
	outOctets      uint64
	outUcastPkts   uint64
	outNUcastPkts  uint64
	outDiscards    uint64
	outErrors      uint64
	outQLen        uint64
	_              uint32
	_              uint32
	_              sockaddrInet
	_              sockaddrInet
	_              uint32
	_              uint32
	_              [40]byte
}

func platformNet() Net {
	var table uintptr
	r, _, _ := pGetIfTable2.Call(1, uintptr(unsafe.Pointer(&table)))
	if r != 0 || table == 0 {
		return Net{}
	}
	defer pFreeMibTable.Call(table)
	num := *(*uint32)(unsafe.Pointer(table))
	rowPtr := table + 8
	rowSize := unsafe.Sizeof(mibIfRow2{})
	var rx, tx uint64
	for i := uint32(0); i < num; i++ {
		row := (*mibIfRow2)(unsafe.Pointer(rowPtr + uintptr(i)*rowSize))
		rx += row.inOctets
		tx += row.outOctets
	}
	return Net{rx, tx}
}

func platformUptime() int64 {
	r, _, _ := pGetTickCount64.Call()
	return int64(r / 1000)
}

func platformLoad() []float64 { return []float64{0, 0, 0} } // Windows has no load average

func defaultDiskPath() string { return `C:\` }

func syscallExec(exe string) error { return nil } // handled by swap .bat on Windows
func execCommand(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }

// Windows locks a running exe, so we stage the new one and use a .bat helper
// that waits for exit, swaps the file, and relaunches with the original args.
func writeSwapBat(exe, newExe string) {
	bat := exe + ".swap.bat"
	pid := os.Getpid()
	args := strings.Join(os.Args[1:], " ")
	script := "@echo off\r\n" +
		":wait\r\n" +
		"tasklist /FI \"PID eq " + itoa(pid) + "\" 2>NUL | find \"" + itoa(pid) + "\" >NUL\r\n" +
		"if errorlevel 1 goto swap\r\n" +
		"ping -n 2 127.0.0.1 >NUL\r\n" +
		"goto wait\r\n" +
		":swap\r\n" +
		"move /Y \"" + newExe + "\" \"" + exe + "\" >NUL\r\n" +
		"start \"\" \"" + exe + "\" " + args + "\r\n" +
		"del \"%~f0\"\r\n"
	_ = os.WriteFile(bat, []byte(script), 0644)
	_ = execCommand("cmd", "/c", "start", "/min", "", bat).Start()
}

func itoa(n int) string {
	if n == 0 { return "0" }
	neg := n < 0
	if neg { n = -n }
	var b [20]byte
	i := len(b)
	for n > 0 { i--; b[i] = byte('0' + n%10); n /= 10 }
	if neg { i--; b[i] = '-' }
	return string(b[i:])
}
