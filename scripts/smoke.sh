#!/usr/bin/env bash
# Production smoke test - run against any deployed Verso URL:
#   ./scripts/smoke.sh https://verso-xxxx.onrender.com
# Exercises health, auth, document CRUD, sharing enforcement, and AI status
# using the seeded demo accounts. Exit code 0 = all checks passed.
set -u
BASE="${1:?usage: smoke.sh <base-url>}"
BASE="${BASE%/}"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1 -> $2"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval('j'+process.argv[1]);console.log(v===undefined||v===null?'':v)}catch{console.log('')}})" "$1"; }

echo "Smoke testing $BASE"
H=$(curl -s --max-time 60 "$BASE/api/health")
[ "$(echo "$H" | json .ok)" = "true" ] && ok "health" || bad "health" "$H"

M=$(curl -s "$BASE/api/meta")
ENGINE=$(echo "$M" | json .ai.engine)
[ -n "$ENGINE" ] && ok "meta (AI engine: $ENGINE)" || bad "meta" "$M"

ADA=$(curl -s "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"ada@demo.verso.app","password":"VersoDemo1!"}' | json .token)
[ -n "$ADA" ] && ok "login ada" || bad "login ada" "no token (is the DB seeded?)"
GRACE=$(curl -s "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"grace@demo.verso.app","password":"VersoDemo1!"}' | json .token)
[ -n "$GRACE" ] && ok "login grace" || bad "login grace" "no token"

BAD=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"ada@demo.verso.app","password":"wrong"}')
[ "$BAD" = "401" ] && ok "wrong password -> 401" || bad "wrong password" "$BAD"

DOC=$(curl -s "$BASE/api/docs" -H "Authorization: Bearer $ADA" -H 'Content-Type: application/json' \
  -X POST -d '{"title":"Smoke test doc"}' | json .id)
[ -n "$DOC" ] && ok "create doc" || bad "create doc" "no id"

SAVE=$(curl -s -X PUT "$BASE/api/docs/$DOC/content" -H "Authorization: Bearer $ADA" -H 'Content-Type: application/json' \
  -d '{"baseVersion":1,"content":{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Smoke"}]},{"type":"paragraph","content":[{"type":"text","text":"bold","marks":[{"type":"bold"}]}]}]}}' | json .version)
[ "$SAVE" = "2" ] && ok "save content -> v2" || bad "save content" "$SAVE"

RT=$(curl -s "$BASE/api/docs/$DOC" -H "Authorization: Bearer $ADA" | json '.content.content[0].type')
[ "$RT" = "heading" ] && ok "formatting round-trips" || bad "round-trip" "$RT"

STALE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/docs/$DOC/content" -H "Authorization: Bearer $ADA" -H 'Content-Type: application/json' \
  -d '{"baseVersion":1,"content":{"type":"doc","content":[{"type":"paragraph"}]}}')
[ "$STALE" = "409" ] && ok "stale save -> 409 conflict" || bad "stale save" "$STALE"

DENY=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/docs/$DOC" -H "Authorization: Bearer $GRACE")
[ "$DENY" = "403" ] && ok "non-collaborator -> 403" || bad "non-collaborator" "$DENY"

SH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/docs/$DOC/shares" -H "Authorization: Bearer $ADA" -H 'Content-Type: application/json' \
  -d '{"email":"grace@demo.verso.app","role":"viewer"}')
[ "$SH" = "201" ] && ok "share as viewer -> 201" || bad "share" "$SH"

VIEW=$(curl -s "$BASE/api/docs/$DOC" -H "Authorization: Bearer $GRACE" | json .myRole)
[ "$VIEW" = "viewer" ] && ok "viewer can read" || bad "viewer read" "$VIEW"

VW=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/docs/$DOC/content" -H "Authorization: Bearer $GRACE" -H 'Content-Type: application/json' \
  -d '{"baseVersion":2,"content":{"type":"doc","content":[{"type":"paragraph"}]}}')
[ "$VW" = "403" ] && ok "viewer write -> 403" || bad "viewer write" "$VW"

EXP=$(curl -s "$BASE/api/docs/$DOC/export?format=md" -H "Authorization: Bearer $ADA" | head -c 7)
[ "$EXP" = "# Smoke" ] && ok "markdown export" || bad "export" "$EXP"

AI=$(curl -s -N --max-time 60 "$BASE/api/ai/summarize" -H "Authorization: Bearer $ADA" -H 'Content-Type: application/json' \
  -d "{\"docId\":\"$DOC\"}" | grep -c '"type":"chunk"')
[ "$AI" -ge 1 ] && ok "AI summarize streams ($ENGINE)" || bad "AI summarize" "no chunks"

DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/docs/$DOC" -H "Authorization: Bearer $ADA")
[ "$DEL" = "204" ] && ok "delete doc (cleanup)" || bad "delete" "$DEL"

HDR=$(curl -s -I "$BASE/" | grep -ci "content-security-policy")
[ "$HDR" -ge 1 ] && ok "security headers present" || bad "security headers" "missing CSP"

echo; echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
