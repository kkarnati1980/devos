#!/usr/bin/env bash
# DevOS server check (S4-c1, DEVOS-128, docs/modules/S4.md "S4-c probe decisions"): F3-1 and F3-2 on the real host.
#  AT11 (every project container): docker inspect of each container on a devos-p<idx> bridge shows NanoCpus, Memory
#        and PidsLimit > 0 and no-new-privileges in SecurityOpt. Named fields only (a bare inspect prints the env).
#  AT10 (the probe project only): a throwaway container on each devos-p-devos-probe-s4-<env> network, with a project
#        service's floor (cap-drop ALL, no-new-privileges, read-only, nobody, cpu/memory/pids caps), tries TCP to the
#        host's admin and DevOS ports, the metadata address, the other probe env's containers and the host's tailnet
#        address (each must time out or be unreachable within 3 s; refused or open fails), and one HTTPS GET, which
#        must fail without declared egress and return 200 with it.
# Exit 0 pass, 1 fail, 3 skipped (no docker; or AT11 passed and no probe network exists, so AT10 could not run).
# Prints at most 10 failure lines and a summary; only addresses, ports and fixed outcomes. Never a secret.
set -uo pipefail
DIR="${DEVOS_DIR:-/root/.devos}"
EX="${ISO_EXEC_SECONDS:-15}"          # each docker call
RUN_S="${ISO_PROBE_SECONDS:-60}"       # the probe container, whole run
PROBE_SLUG="devos-probe-s4"
ADMIN_PORTS="22 8000 6001 6002 3001 3000"
EGRESS_URL="https://api.github.com/zen"
command -v docker >/dev/null 2>&1 || { echo "skipped: docker not installed"; exit 3; }
d() { timeout "$EX" docker "$@" 2>/dev/null; }
IPV4='^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$'
fails=() checked=0
fail() { fails+=("$1"); }

# --- AT11: limits on every container attached to a devos-p<idx> bridge ------------------------------------------
nets="$(d network ls --format '{{.Name}}')" || { echo "fail: cannot list docker networks"; exit 1; }
declare -A bridge_of=()
while read -r n; do
  [[ "$n" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || continue
  b="$(d network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$n")" || { fail "AT11 network $n: cannot inspect"; continue; }
  [[ "$b" =~ ^devos-p(0|[1-9][0-9]{0,3})$ ]] && bridge_of[$n]="$b"
done <<<"$nets"
for n in "${!bridge_of[@]}"; do
  ids="$(d network inspect --format '{{range $id, $c := .Containers}}{{$id}} {{end}}' "$n")" || { fail "AT11 network $n: cannot list containers"; continue; }
  for id in $ids; do
    [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || continue
    line="$(d inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{json .HostConfig.SecurityOpt}}' "$id")" || { fail "AT11 ${id:0:12} on $n: cannot inspect"; continue; }
    read -r cpu mem pids sec <<<"$line"
    checked=$((checked + 1))
    [[ "$cpu" =~ ^[1-9][0-9]*$ && "$mem" =~ ^[1-9][0-9]*$ && "$pids" =~ ^[1-9][0-9]*$ ]] || fail "AT11 ${id:0:12} on $n: missing cpu/memory/pids limit"
    [[ "$sec" == *'"no-new-privileges'* ]] || fail "AT11 ${id:0:12} on $n: no no-new-privileges"
  done
done

# --- AT10: the network probe from inside the probe project's own networks -----------------------------------------
probe_nets=()
for n in "${!bridge_of[@]}"; do [[ "$n" =~ ^devos-p-${PROBE_SLUG}-(preview|live)$ ]] && probe_nets+=("$n"); done
at10="skipped"
if (( ${#probe_nets[@]} )); then
  img="$(d ps --filter label=io.devos.service=api --filter status=running --format '{{.Image}}' | head -n1)"
  [[ "$img" =~ ^[a-z0-9][a-z0-9._/:@-]{0,199}$ ]] || { fail "AT10: no running DevOS API image to probe with"; img=""; }
  ts="$(timeout 5 ip -4 -o addr show dev tailscale0 2>/dev/null | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p' | head -n1)"
  [[ "$ts" =~ $IPV4 ]] || ts=""
  # The probe program: fixed text on stdin; its arguments are validated ip:port pairs and the fixed egress URL.
  PROG='const net=require("net");const [,,url,...t]=process.argv;
const tcp=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:+p});const done=x=>{s.destroy();r(x)};s.setTimeout(3000,()=>done("timeout"));
s.on("connect",()=>done("open"));s.on("error",e=>done(e.code==="ECONNREFUSED"?"refused":/EHOSTUNREACH|ENETUNREACH|EACCES|EPERM/.test(e.code)?"unreachable":"error"))});
(async()=>{for(const x of t){const[h,p]=x.split(":");console.log(x+" "+await tcp(h,p))}
let e="blocked";try{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});e="status-"+r.status}catch{}console.log("egress "+e)})();'
  for n in "${probe_nets[@]}"; do
    [[ -n "$img" ]] || break
    env="${n##*-}"
    gw="$(d network inspect --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$n")"
    [[ "$gw" =~ $IPV4 ]] || { fail "AT10 $n: no IPv4 gateway"; continue; }
    targets=()
    for p in $ADMIN_PORTS; do targets+=("$gw:$p"); done
    targets+=("169.254.169.254:80")
    [[ -n "$ts" ]] && targets+=("$ts:443")
    for o in "${probe_nets[@]}"; do
      [[ "$o" == "$n" ]] && continue
      for ip in $(d network inspect --format '{{range .Containers}}{{.IPv4Address}} {{end}}' "$o" | tr ' ' '\n' | sed 's#/.*##' | head -n 5); do
        [[ "$ip" =~ $IPV4 ]] && targets+=("$ip:5432")
      done
    done
    declared=false
    grep -q -- "--comment \"${PROBE_SLUG}/${env} egress\"" "$DIR/isolation/installed.rules" 2>/dev/null && declared=true
    out="$(timeout "$RUN_S" docker run --rm -i --network "$n" --cap-drop ALL --security-opt no-new-privileges:true --read-only \
      --user 65534:65534 --cpus 0.25 --memory 128m --pids-limit 32 --entrypoint node "$img" - "$EGRESS_URL" "${targets[@]}" <<<"$PROG" 2>/dev/null)" \
      || { fail "AT10 $n: the probe container did not run"; continue; }
    for x in "${targets[@]}"; do
      r="$(printf '%s\n' "$out" | sed -n "s/^${x//./\\.} \([a-z]*\)$/\1/p" | head -n1)"
      case "$r" in timeout|unreachable) ;; "") fail "AT10 $n: $x not probed" ;; *) fail "AT10 $n: $x $r" ;; esac
    done
    eg="$(printf '%s\n' "$out" | sed -n 's/^egress \(blocked\|status-[0-9]\{3\}\)$/\1/p' | head -n1)"
    if [[ "$declared" == true ]]; then
      [[ "$eg" == status-200 ]] || fail "AT10 $n: declared egress gave ${eg:-nothing}"
    else
      [[ "$eg" == blocked ]] || fail "AT10 $n: undeclared egress gave ${eg:-nothing}"
    fi
    at10="ran"
    [[ "$declared" == true ]] && at10_declared=1
  done
fi

if (( ${#fails[@]} )); then
  printf '%s\n' "${fails[@]:0:10}"
  echo "fail: ${#fails[@]} problem(s); AT11 checked $checked container(s); AT10 $at10"
  exit 1
fi
[[ "$at10" == ran && -z "${at10_declared:-}" ]] && echo "note: AT10's declared-egress half is not yet testable (no probe stack has declared egress, DEVOS-201)"
if [[ "$at10" == skipped ]]; then echo "skipped: AT11 passed on $checked container(s); no ${PROBE_SLUG} network, so AT10 did not run"; exit 3; fi
echo "ok: AT11 passed on $checked container(s); AT10 passed on ${#probe_nets[@]} probe network(s)"
exit 0
