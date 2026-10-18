package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func setup(t *testing.T) (base, home, work string) {
	t.Helper()
	home, _ = filepath.EvalSymlinks(t.TempDir())
	base = filepath.Join(home, ".claude-multi-account")
	work = filepath.Join(home, "work")
	for _, d := range []string{base, filepath.Join(work, "acme", "app"), filepath.Join(work, "mine")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(base, "accounts"), "personal\t~/.claude\nacme\t~/.claude-acme\n# a comment\n")
	write(t, filepath.Join(base, "folders"), "*\tpersonal\n"+filepath.Join(work, "acme")+"\tacme\n")
	return
}

func write(t *testing.T, file, text string) {
	t.Helper()
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLongestRuleWinsAndSubfoldersFollow(t *testing.T) {
	base, home, work := setup(t)
	if got := resolveDir(base, home, filepath.Join(work, "acme", "app")); got != filepath.Join(home, ".claude-acme") {
		t.Fatalf("acme subfolder resolved to %q", got)
	}
	if got := resolveDir(base, home, filepath.Join(work, "mine")); got != filepath.Join(home, ".claude") {
		t.Fatalf("default resolved to %q", got)
	}
	if got := resolveDir(base, home, filepath.Join(work, "acme-other")); got != filepath.Join(home, ".claude") {
		t.Fatalf("a sibling with the same prefix must not match the rule, got %q", got)
	}
}

func TestNoFilesMeansNoAccount(t *testing.T) {
	home := t.TempDir()
	if got := resolveDir(filepath.Join(home, "missing"), home, home); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestWindowsStylePaths(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows path rules")
	}
	_, home, _ := setup(t)
	rules := [][2]string{{`C:\Work\Acme`, "acme"}, {"*", "personal"}}
	if got := accountFor(`c:\work\acme\app`, rules, home); got != "acme" {
		t.Fatalf("case and slashes should not matter on Windows, got %q", got)
	}
	if got := accountFor(`C:/Work/Acme/app`, rules, home); got != "acme" {
		t.Fatalf("forward slashes should match, got %q", got)
	}
}

func TestExecSetsTheConfigDirAndDropsItForTheDefault(t *testing.T) {
	base, home, work := setup(t)
	bin := filepath.Join(t.TempDir(), "cma")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	printEnv := []string{"sh", "-c", "echo dir=$CLAUDE_CONFIG_DIR"}
	if runtime.GOOS == "windows" {
		printEnv = []string{"cmd", "/c", "echo dir=%CLAUDE_CONFIG_DIR%"}
	}
	runIn := func(dir string) string {
		cmd := exec.Command(bin, append([]string{"exec"}, printEnv...)...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "CLAUDE_MULTI_ACCOUNT_HOME="+base, "CLAUDE_CONFIG_DIR=/stale", "HOME="+home, "USERPROFILE="+home)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("exec: %v\n%s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if got := runIn(filepath.Join(work, "acme", "app")); got != "dir="+filepath.Join(home, ".claude-acme") {
		t.Fatalf("acme folder: %q", got)
	}
	if got := runIn(filepath.Join(work, "mine")); got != "dir=" && got != "dir=%CLAUDE_CONFIG_DIR%" {
		t.Fatalf("the default account must run without CLAUDE_CONFIG_DIR, got %q", got)
	}

	launcher := filepath.Join(filepath.Dir(bin), "claude-launcher")
	if runtime.GOOS == "windows" {
		launcher += ".exe"
	}
	data, _ := os.ReadFile(bin)
	write(t, launcher, string(data))
	os.Chmod(launcher, 0o755)
	cmd := exec.Command(launcher, printEnv...)
	cmd.Dir = filepath.Join(work, "acme")
	cmd.Env = append(os.Environ(), "CLAUDE_MULTI_ACCOUNT_HOME="+base, "HOME="+home, "USERPROFILE="+home)
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "dir="+filepath.Join(home, ".claude-acme") {
		t.Fatalf("claude-launcher acts as cma exec: %v %q", err, out)
	}
}

func TestExitCodeIsPassedThrough(t *testing.T) {
	base, home, _ := setup(t)
	cmd := []string{"sh", "-c", "exit 7"}
	if runtime.GOOS == "windows" {
		cmd = []string{"cmd", "/c", "exit 7"}
	}
	if code := run(base, home, cmd); code != 7 {
		t.Fatalf("exit code %d", code)
	}
}
