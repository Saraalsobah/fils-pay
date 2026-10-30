#!/usr/bin/env python3
"""Small load test for the live FilsPay server (standard library only, no installs).

Usage:   python3 scripts/loadtest.py https://165-232-189-108.sslip.io
Method:  for each target, ramp concurrent "users" (threads, each a keep-alive HTTPS
         connection sending requests back to back) in steps, 15 s per step, and record
         requests/second, latency percentiles and the share of failed requests.
Targets: /healthz                       (API alive, never touches the database)
         /v1/payment-links/<bad token>  (public checkout lookup: one database query, answers 404)
Output:  a table on screen and loadtest_results.json next to where you run it.
"""
import http.client, json, ssl, statistics, sys, threading, time, urllib.parse, uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://165-232-189-108.sslip.io"
STEP_SECONDS = 15
LEVELS = [5, 20, 50, 100, 200]
TARGETS = [("healthz (no database)", "/healthz", {200}),
           ("checkout lookup (1 DB query)", "/v1/payment-links/" + uuid.uuid4().hex, {404})]

u = urllib.parse.urlparse(BASE)
ctx = ssl.create_default_context()


def worker(path, ok_codes, stop_at, lat, errs):
    conn = None
    while time.time() < stop_at:
        try:
            if conn is None:
                conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=10, context=ctx)
            t = time.perf_counter()
            conn.request("GET", path)
            r = conn.getresponse()
            r.read()
            ms = (time.perf_counter() - t) * 1000
            if r.status in ok_codes:
                lat.append(ms)
            else:
                errs.append(r.status)
        except Exception as e:  # timeouts, resets
            errs.append(type(e).__name__)
            try:
                conn.close()
            except Exception:
                pass
            conn = None


def pct(v, p):
    return v[min(len(v) - 1, int(len(v) * p))] if v else float("nan")


results = []
for name, path, ok in TARGETS:
    print(f"\n== {name}  {BASE}{path[:30]}")
    print(f"{'users':>6} {'req/s':>8} {'p50 ms':>8} {'p95 ms':>8} {'p99 ms':>8} {'failed %':>9}  failure kinds")
    for n in LEVELS:
        lat, errs, threads = [], [], []
        stop_at = time.time() + STEP_SECONDS
        for _ in range(n):
            th = threading.Thread(target=worker, args=(path, ok, stop_at, lat, errs))
            th.start(); threads.append(th)
        for th in threads:
            th.join()
        lat.sort()
        total = len(lat) + len(errs)
        kinds = {}
        for e in errs:
            kinds[str(e)] = kinds.get(str(e), 0) + 1
        row = dict(target=name, users=n, rps=round(total / STEP_SECONDS, 1), p50=round(pct(lat, .5), 1),
                   p95=round(pct(lat, .95), 1), p99=round(pct(lat, .99), 1),
                   failed_pct=round(100 * len(errs) / total, 2) if total else 100, kinds=kinds)
        results.append(row)
        print(f"{n:>6} {row['rps']:>8} {row['p50']:>8} {row['p95']:>8} {row['p99']:>8} {row['failed_pct']:>9}  {kinds}")
        time.sleep(5)  # let the server settle between steps (also shows recovery)

# Recovery check: after the heaviest step, is the server answering normally again?
time.sleep(5)
t = time.perf_counter()
c = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=10, context=ctx)
c.request("GET", "/healthz"); r = c.getresponse(); r.read()
print(f"\nrecovery: /healthz -> {r.status} in {(time.perf_counter() - t) * 1000:.0f} ms, 10 s after the last step")
json.dump(results, open("loadtest_results.json", "w"), indent=1)
print("saved loadtest_results.json")
