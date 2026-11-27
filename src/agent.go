// tinyprobe agent — standard library only, statically compiled, self-updating.
// Cross-platform: Linux (/proc) + Windows (Win32 via syscall.NewLazyDLL).
// Build Linux:   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.Version=v1.2.0" -o probe-linux-amd64 agent.go
// Build Windows: CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.Version=v1.2.0" -o probe-windows-amd64.exe agent.go
package main

import (
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
	"time"
)

// Version is injected at build time via -ldflags "-X main.Version=v1.2.0".
var Version = "dev"

// ServiceName (Linux systemd unit / Windows scheduled task name) for self-update restart.
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

type Command struct {
	Cmd     string `json:"cmd"`
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

// ============ CPU ============
type cpuSample struct{ idle, total uint64 }

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
	return round1(p), cur
}

// ============ MEM / DISK / NET / UPTIME / LOAD : implemented per-OS ============

func readMem() Mem    { return platformMem() }
func readDisk(p string) *Disk { return platformDisk(p) }
func readNet() Net    { return platformNet() }
func readUptime() int64 { return platformUptime() }
func readLoad() []float64 { return platformLoad() }

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
	h := sha256.New()
	if runtime.GOOS == "windows" {
		// Windows locks the running exe: download to sibling, verify, then use a
		// swap helper (.bat) that waits for exit, replaces, and relaunches.
		tmp := exe + ".new"
		f, e := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
		if e != nil {
			fmt.Println("update: temp:", e)
			return
		}
		_, e = io.Copy(io.MultiWriter(f, h), resp.Body)
		f.Close()
		if e != nil {
			os.Remove(tmp)
			fmt.Println("update: write:", e)
			return
		}
		sum := hex.EncodeToString(h.Sum(nil))
		if cmd.SHA256 != "" && !strings.EqualFold(sum, cmd.SHA256) {
			os.Remove(tmp)
			fmt.Printf("update: sha256 mismatch got=%s want=%s\n", sum, cmd.SHA256)
			return
		}
		writeSwapBat(exe, tmp)
		fmt.Printf("update: staged %s sha256=%s, restarting via swap helper\n", cmd.Version, sum)
		restart()
		return
	}
	// Linux: rename over a running exe is safe.
	tmp := exe + ".update.tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		fmt.Println("update: temp file:", err)
		return
	}
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
	if err := os.Rename(tmp, exe); err != nil {
		os.Remove(tmp)
		fmt.Println("update: rename:", err)
		return
	}
	fmt.Printf("update: installed %s sha256=%s\n", cmd.Version, sum)
	restart()
}

func restart() {
	if runtime.GOOS == "windows" {
		// The swap .bat will wait, replace, and relaunch. Just exit.
		os.Exit(0)
	}
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
	_ = syscallExec(exe)
	os.Exit(0)
}

func main() {
	hub := flag.String("hub", "http://127.0.0.1:47821", "hub URL")
	name := flag.String("name", "", "node name (default hostname)")
	interval := flag.Int("interval", 2, "report interval seconds")
	diskPath := flag.String("disk", defaultDiskPath(), "disk mount/drive to monitor")
	token := flag.String("token", "", "optional X-Token")
	service := flag.String("service", "tinyprobe", "systemd unit / scheduled task name for self-update restart")
	envfile := flag.String("envfile", "", "optional root-only env file (KEY=VALUE) for secrets")
	flag.Parse()
	ServiceName = *service

	// Load secrets from a hidden root-only file so `ps` never shows plaintext.
	if *envfile != "" {
		if b, err := os.ReadFile(*envfile); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") { continue }
				kv := strings.SplitN(line, "=", 2)
				if len(kv) != 2 { continue }
				k, v := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
				switch k {
				case "TP_HUB": *hub = v
				case "TP_NAME": *name = v
				case "TP_TOKEN": *token = v
				case "TP_SERVICE": *service = v; ServiceName = v
				case "TP_INTERVAL": if n, e := strconv.Atoi(v); e == nil { *interval = n }
				case "TP_DISK": *diskPath = v
				}
			}
		}
	}

	host, _ := os.Hostname()
	if *name == "" {
		*name = host
	}

	prevCPU := readCPU()
	prevNet := readNet()
	lastAt := time.Now()
	first := true

	client := &http.Client{Timeout: 8 * time.Second}

	fmt.Printf("tinyprobe(go) v%s %s/%s -> %s as %q every %ds\n", Version, runtime.GOOS, runtime.GOARCH, *hub, *name, *interval)
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
			Uptime: readUptime(), CPU: cpu, CPUs: runtime.NumCPU(),
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
