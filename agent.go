// tinyprobe agent — standard library only, statically compiled, self-updating.
// Build: CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.Version=v1.1.0" -o probe-linux-amd64 agent.go
// Run:   ./probe-linux-amd64 -hub http://HUB:47821 -name web-01 -interval 2
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// Version is injected at build time via -ldflags "-X main.Version=v1.1.0".
var Version = "dev"

// ServiceName is used when restarting via systemd after a self-update.
var ServiceName = "tinyprobe"

type Payload struct {
	Name     string    `json:"name"`
	Host     string    `json:"host"`
	Platform string    `json:"platform"`
	Arch     string    `json:"arch"`
	Version  string    `json:"version"`
	Go       string    `json:"go"`
	Time     int64     `json:"time"`
	Uptime   int64     `json:"uptime"`
	CPU      float64   `json:"cpu"`
	CPUs     int       `json:"cpus"`
	Load     []float64 `json:"load"`
	Mem      Mem       `json:"mem"`
	Disk     *Disk     `json:"disk"`
	Net      Net       `json:"net"`
}

type Mem struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

type Disk struct {
	Path    string  `json:"path"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

type Net struct {
	RX uint64 `json:"rx"`
	TX uint64 `json:"tx"`
}

// Command is a one-shot instruction returned by the hub in the report response.
type Command struct {
	Cmd     string `json:"cmd"` // "update"
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

type cpuSample struct{ idle, total uint64 }

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
	idx := 1
	nums := []*uint64{&user, &nice, &sys, &idle, &iowait, &irq, &softirq}
	for i, n := range nums {
		if idx+i < len(fields) {
			*n, _ = strconv.ParseUint(fields[idx+i], 10, 64)
		}
	}
	return cpuSample{idle + iowait, user + nice + sys + idle + iowait + irq + softirq}
}

func cpuPercent(prev cpuSample) (float64, cpuSample) {
	cur := readCPU()
	dt := cur.total - prev.total
	di := cur.idle - prev.idle
	if dt == 0 {
		return 0, cur
	}
	p := (1 - float64(di)/float64(dt)) * 100
	if p < 0 {
		p = 0
	}
	if p > 100 {
		p = 100
	}
	return p, cur
}

func readMem() Mem {
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

func readDisk(path string) *Disk {
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

func readNet() Net {
	var rx, tx uint64
	f, err := os.Open("/proc/net/dev")
	if err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			line := s.Text()
			colon := strings.Index(line, ":")
			if colon < 0 {
				continue
			}
			if strings.TrimSpace(line[:colon]) == "lo" {
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

func netRates(prev Net, dt float64, first bool) (Net, Net) {
	cur := readNet()
	if first || dt <= 0 {
		return Net{}, cur
	}
	drx, dtx := uint64(0), uint64(0)
	if cur.RX >= prev.RX {
		drx = uint64(float64(cur.RX-prev.RX) / dt)
	}
	if cur.TX >= prev.TX {
		dtx = uint64(float64(cur.TX-prev.TX) / dt)
	}
	return Net{drx, dtx}, cur
}

func readUptime() int64 {
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

func readLoad() []float64 {
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

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

func human(b uint64) string {
	units := []string{"B", "K", "M", "G", "T"}
	f := float64(b)
	i := 0
	for f >= 1024 && i < len(units)-1 {
		f /= 1024
		i++
	}
	return fmt.Sprintf("%.1f%s", f, units[i])
}

var updating atomic.Bool

func doUpdate(client *http.Client, cmd Command) {
	if cmd.URL == "" {
		fmt.Println("update skipped: empty url")
		return
	}
	if cmd.Version == Version && Version != "dev" {
		fmt.Println("update skipped: already on", Version)
		return
	}
	fmt.Printf("update -> %s (%s)\n", cmd.Version, cmd.URL)
	resp, err := client.Get(cmd.URL)
	if err != nil {
		fmt.Println("update download failed:", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Println("update download status:", resp.Status)
		return
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Println("update: exe path:", err)
		return
	}
	tmp := exe + ".update.tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		fmt.Println("update: temp file:", err)
		return
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmp)
		fmt.Println("update: write:", err)
		return
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if cmd.SHA256 != "" && !strings.EqualFold(sum, cmd.SHA256) {
		os.Remove(tmp)
		fmt.Printf("update: sha256 mismatch got=%s want=%s\n", sum, cmd.SHA256)
		return
	}
	if err := os.Chmod(tmp, 0755); err != nil {
		os.Remove(tmp)
		fmt.Println("update: chmod:", err)
		return
	}
	// On Linux renaming over a running executable is safe; the current process
	// keeps the old inode until restart.
	if err := os.Rename(tmp, exe); err != nil {
		os.Remove(tmp)
		fmt.Println("update: rename:", err)
		return
	}
	fmt.Printf("update: installed %s sha256=%s\n", cmd.Version, sum)
	restart()
}

func restart() {
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		c := exec.Command("systemctl", "restart", ServiceName)
		if err := c.Run(); err == nil {
			fmt.Println("update: systemctl restart", ServiceName)
			os.Exit(0)
		}
	}
	exe, err := os.Executable()
	if err != nil {
		os.Exit(0)
	}
	fmt.Println("update: re-exec self")
	_ = syscall.Exec(exe, os.Args, os.Environ()) // never returns on success
	os.Exit(0)
}

func main() {
	hub := flag.String("hub", "http://127.0.0.1:47821", "hub URL")
	name := flag.String("name", "", "node name (default hostname)")
	interval := flag.Int("interval", 2, "report interval seconds")
	diskPath := flag.String("disk", "/", "disk mount to monitor")
	token := flag.String("token", "", "optional X-Token")
	service := flag.String("service", "tinyprobe", "systemd unit name for self-update restart")
	flag.Parse()
	ServiceName = *service

	host, _ := os.Hostname()
	if *name == "" {
		*name = host
	}

	prevCPU := readCPU()
	prevNet := readNet()
	lastAt := time.Now()
	first := true

	client := &http.Client{Timeout: 8 * time.Second}

	fmt.Printf("tinyprobe(go) v%s -> %s as %q every %ds\n", Version, *hub, *name, *interval)
	for {
		now := time.Now()
		dt := now.Sub(lastAt).Seconds()
		cpu, ncpu := cpuPercent(prevCPU)
		prevCPU = ncpu
		netRate, nnet := netRates(prevNet, dt, first)
		prevNet = nnet
		first = false
		lastAt = now

		p := Payload{
			Name: *name, Host: host, Platform: runtime.GOOS, Arch: runtime.GOARCH,
			Version: Version, Go: runtime.Version(), Time: now.UnixMilli(),
			Uptime: readUptime(), CPU: round1(cpu), CPUs: runtime.NumCPU(),
			Load: readLoad(), Mem: readMem(), Disk: readDisk(*diskPath), Net: netRate,
		}
		body, _ := json.Marshal(p)
		diskPct := "-"
		if p.Disk != nil {
			diskPct = fmt.Sprintf("%.1f%%", p.Disk.Percent)
		}

		status := "err"
		req, err := http.NewRequest("POST", strings.TrimRight(*hub, "/")+"/report", bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			if *token != "" {
				req.Header.Set("X-Token", *token)
			}
			resp, e := client.Do(req)
			if e == nil {
				status = resp.Status
				rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
				resp.Body.Close()
				var reply struct {
					OK  bool     `json:"ok"`
					Cmd *Command `json:"cmd"`
				}
				if json.Unmarshal(rb, &reply) == nil && reply.Cmd != nil && reply.Cmd.Cmd == "update" && !updating.Load() {
					updating.Store(true)
					go func(c Command) {
						defer updating.Store(false)
						doUpdate(client, c)
					}(*reply.Cmd)
				}
			} else {
				status = e.Error()
			}
		}
		fmt.Printf("[%s] %s v%s CPU %.1f%% MEM %.1f%% DISK %s -> %s\n",
			now.Format("15:04:05"), *name, Version, p.CPU, p.Mem.Percent, diskPct, status)
		time.Sleep(time.Duration(*interval) * time.Second)
	}
}
