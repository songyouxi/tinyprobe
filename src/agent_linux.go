//go:build linux

package main

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func readCPU() cpuSample {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}
	}
	defer f.Close()
	line, err := bufio.NewReader(f).ReadString('\n')
	if err != nil {
		return cpuSample{}
	}
	fields := strings.Fields(line)
	var user, nice, sys, idle, iowait, irq, softirq uint64
	nums := []*uint64{&user, &nice, &sys, &idle, &iowait, &irq, &softirq}
	for i, n := range nums {
		if 1+i < len(fields) {
			*n, _ = strconv.ParseUint(fields[1+i], 10, 64)
		}
	}
	return cpuSample{idle + iowait, user + nice + sys + idle + iowait + irq + softirq}
}

func platformMem() Mem {
	total, avail := uint64(0), uint64(0)
	f, err := os.Open("/proc/meminfo")
	if err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			parts := strings.Fields(s.Text())
			if len(parts) < 2 {
				continue
			}
			v, _ := strconv.ParseUint(parts[1], 10, 64)
			switch parts[0] {
			case "MemTotal:":
				total = v * 1024
			case "MemAvailable:":
				avail = v * 1024
			case "MemFree:":
				if avail == 0 {
					avail = v * 1024
				}
			}
		}
		f.Close()
	}
	used, pct := uint64(0), 0.0
	if total > 0 && total >= avail {
		used = total - avail
		pct = float64(used) / float64(total) * 100
	}
	return Mem{total, used, round1(pct)}
}

func platformDisk(path string) *Disk {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil
	}
	total := st.Blocks * uint64(st.Bsize)
	avail := st.Bavail * uint64(st.Bsize)
	used, pct := uint64(0), 0.0
	if total > 0 && total >= avail {
		used = total - avail
		pct = float64(used) / float64(total) * 100
	}
	return &Disk{path, total, used, round1(pct)}
}

func platformNet() Net {
	var rx, tx uint64
	f, err := os.Open("/proc/net/dev")
	if err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			line := s.Text()
			colon := strings.Index(line, ":")
			if colon < 0 || strings.TrimSpace(line[:colon]) == "lo" {
				continue
			}
			fields := strings.Fields(line[colon+1:])
			if len(fields) >= 9 {
				r, _ := strconv.ParseUint(fields[0], 10, 64)
				t, _ := strconv.ParseUint(fields[8], 10, 64)
				rx += r
				tx += t
			}
		}
		f.Close()
	}
	return Net{rx, tx}
}

func platformUptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	parts := strings.Fields(string(b))
	if len(parts) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(parts[0], 64)
	return int64(v)
}

func platformLoad() []float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return []float64{0, 0, 0}
	}
	parts := strings.Fields(string(b))
	out := make([]float64, 0, 3)
	for i := 0; i < 3 && i < len(parts); i++ {
		v, _ := strconv.ParseFloat(parts[i], 64)
		out = append(out, round1(v))
	}
	return out
}

func defaultDiskPath() string { return "/" }

func syscallExec(exe string) error { return syscall.Exec(exe, os.Args, os.Environ()) }
func execCommand(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }
func writeSwapBat(exe, newExe string) {} // no-op on Linux; rename handles it
