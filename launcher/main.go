// Command cma starts Claude Code on the account a folder is set to. It is the Windows counterpart of bin/cma:
// the Claude Code extension launches its wrapper without a shell, so on Windows the wrapper has to be an .exe.
//
//	cma dir [path]       print the Claude config dir the folder runs on (nothing when no rule matches)
//	cma exec cmd ...     run cmd with CLAUDE_CONFIG_DIR set for the current folder
//	claude-launcher ...  the same as cma exec, for claudeCode.claudeProcessWrapper
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	args := os.Args[1:]
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(os.Args[0])), ".exe")
	if name == "claude-launcher" {
		args = append([]string{"exec"}, args...)
	}
	if len(args) == 0 {
		usage()
	}
	home, _ := os.UserHomeDir()
	base := os.Getenv("CLAUDE_MULTI_ACCOUNT_HOME")
	if base == "" {
		base = filepath.Join(home, ".claude-multi-account")
	}
	switch args[0] {
	case "dir":
		dir, _ := os.Getwd()
		if len(args) > 1 {
			dir = args[1]
		}
		if d := resolveDir(base, home, dir); d != "" {
			fmt.Println(d)
		}
	case "exec":
		if len(args) < 2 {
			usage()
		}
		os.Exit(run(base, home, args[1:]))
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: cma dir [path] | cma exec command [args...]")
	os.Exit(2)
}

func resolveDir(base, home, dir string) string {
	accounts := readRows(filepath.Join(base, "accounts"))
	rules := readRows(filepath.Join(base, "folders"))
	if accounts == nil || rules == nil {
		return ""
	}
	// A folder opened through a link: the rule of its own path or of its real path, whichever is more specific,
	// so a "*" rule never hides the real path's rule.
	dirs := []string{dir}
	if real, err := filepath.EvalSymlinks(dir); err == nil && real != dir {
		dirs = append(dirs, real)
	}
	name := accountForAny(dirs, rules, home)
	for _, a := range accounts {
		if a[0] == name {
			return expand(a[1], home)
		}
	}
	return ""
}

func run(base, home string, command []string) int {
	cwd, _ := os.Getwd()
	env := os.Environ()
	if d := resolveDir(base, home, cwd); d != "" {
		env = withoutVar(env, "CLAUDE_CONFIG_DIR")
		if key(d) != key(filepath.Join(home, ".claude")) {
			env = append(env, "CLAUDE_CONFIG_DIR="+d)
		}
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "cma:", err)
		return 127
	}
	return 0
}

func withoutVar(env []string, name string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(strings.ToUpper(kv), strings.ToUpper(name)+"=") {
			out = append(out, kv)
		}
	}
	return out
}

// readRows reads a tab-separated file, skipping blank lines and # comments, and tolerating a BOM, CRLF line endings
// and spaces around the fields, like the extension does. It returns nil when the file is missing.
func readRows(file string) [][2]string {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	rows := [][2]string{}
	text := strings.TrimPrefix(string(data), "\uFEFF")
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			continue
		}
		rows = append(rows, [2]string{strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])})
	}
	return rows
}

func expand(p, home string) string {
	if p == "~" {
		p = home
	} else if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		p = filepath.Join(home, p[2:])
	}
	return filepath.Clean(p)
}

// key is how two paths are compared: forward slashes, no trailing slash, and case-insensitive on Windows.
func key(p string) string {
	k := strings.TrimRight(filepath.ToSlash(filepath.Clean(p)), "/")
	if caseInsensitive {
		k = strings.ToLower(k)
	}
	return k
}

// accountFor returns the account of the longest folder rule that contains dir, else the "*" rule.
func accountFor(dir string, rules [][2]string, home string) string {
	return accountForAny([]string{dir}, rules, home)
}

// accountForAny is accountFor over several spellings of one folder: the longest rule containing any of them.
func accountForAny(dirs []string, rules [][2]string, home string) string {
	best, bestLen := "", -1
	for _, r := range rules {
		if r[0] == "*" {
			if bestLen < 0 {
				best, bestLen = r[1], 0
			}
			continue
		}
		p := key(expand(r[0], home))
		for _, dir := range dirs {
			d := key(dir)
			if (d == p || strings.HasPrefix(d, p+"/")) && len(p) > bestLen {
				best, bestLen = r[1], len(p)
			}
		}
	}
	return best
}
