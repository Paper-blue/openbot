#!/usr/bin/env bash
set -euo pipefail

report_path=".openbot-build/macos-self-signed-requirement-probe.json"
identity_common_name="OpenBot Self-Signed Requirement Probe"
bundle_identifier="com.openbot.signature-probe"
first_version="1.0.0"
second_version="1.1.0"

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

require_github_hosted_macos() {
  [ "${GITHUB_ACTIONS:-}" = "true" ] || fail "This probe runs only in GitHub Actions."
  [ "${RUNNER_OS:-}" = "macOS" ] || fail "This probe runs only on a macOS runner."
  [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail "This probe runs only on a GitHub-hosted runner."
  [ -n "${RUNNER_TEMP:-}" ] || fail "RUNNER_TEMP is missing."
}

make_openssl_config() {
  local config_path="$1"
  cat >"$config_path" <<CONFIG
[req]
distinguished_name = distinguished_name
x509_extensions = code_signing
prompt = no

[distinguished_name]
CN = $identity_common_name

[code_signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CONFIG
}

make_probe_executable() {
  local source_path="$1"
  local executable_path="$2"
  local exit_code="$3"
  cat >"$source_path" <<SOURCE
int main(void) { return $exit_code; }
SOURCE
  /usr/bin/clang -o "$executable_path" "$source_path"
}

make_bundle() {
  local bundle_path="$1"
  local version="$2"
  local executable_source="$3"
  mkdir -p "$bundle_path/Contents/MacOS"
  cp "$executable_source" "$bundle_path/Contents/MacOS/Probe"
  chmod 755 "$bundle_path/Contents/MacOS/Probe"
  printf 'APPL????' >"$bundle_path/Contents/PkgInfo"
  cat >"$bundle_path/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Probe</string>
	<key>CFBundleIdentifier</key>
	<string>$bundle_identifier</string>
	<key>CFBundleName</key>
	<string>SignatureProbe</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
</dict>
</plist>
PLIST
}

designated_requirement() {
  codesign --display --requirements - "$1" 2>&1 | sed -n 's/^designated => //p'
}

cdhash_of() {
  codesign --display --verbose=4 "$1" 2>&1 | sed -n 's/^CandidateCDHash sha256=//p' | head -1
}

require_github_hosted_macos

work_dir="$(mktemp -d "$RUNNER_TEMP/openbot-signature-probe.XXXXXX")"
keychain_path="$work_dir/probe.keychain-db"
keychain_password="$(openssl rand -hex 32)"
echo "::add-mask::$keychain_password"
p12_password="$(openssl rand -hex 32)"
echo "::add-mask::$p12_password"
openssl_config="$work_dir/openssl.cnf"
key_path="$work_dir/key.pem"
certificate_path="$work_dir/certificate.pem"
identity_path="$work_dir/identity.p12"

previous_keychains=()
while IFS= read -r line; do
  entry="${line#*\"}"
  entry="${entry%\"*}"
  if [ -n "$entry" ]; then previous_keychains+=("$entry"); fi
done < <(security list-keychains -d user)

restore_keychain_search_list() {
  if [ "${#previous_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${previous_keychains[@]}" >/dev/null 2>&1 || true
  fi
}

remove_user_trust() {
  if [ -f "$certificate_path" ]; then
    security remove-trusted-cert "$certificate_path" >/dev/null 2>&1 || true
  fi
}

cleanup_environment() {
  restore_keychain_search_list
  remove_user_trust
  if [ -e "$keychain_path" ]; then
    security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup_environment EXIT

make_openssl_config "$openssl_config"
/usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$key_path" -out "$certificate_path" -config "$openssl_config"
/usr/bin/openssl pkcs12 -export -inkey "$key_path" -in "$certificate_path" \
  -out "$identity_path" -name "$identity_common_name" -passout "pass:$p12_password"

security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 3600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$identity_path" -k "$keychain_path" -P "$p12_password" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path" >/dev/null
security list-keychains -d user -s "$keychain_path" ${previous_keychains[@]+"${previous_keychains[@]}"} >/dev/null

trust_install_status=0
trust_install_output="$(security add-trusted-cert -r trustRoot -p codeSign -k "$keychain_path" "$certificate_path" 2>&1)" || trust_install_status=$?

find_identity_output="$(security find-identity -v -p codesigning "$keychain_path" 2>&1 || true)"

make_probe_executable "$work_dir/probe-a.c" "$work_dir/probe-a" 0
make_probe_executable "$work_dir/probe-b.c" "$work_dir/probe-b" 1

first_bundle="$work_dir/first/Probe.app"
second_bundle="$work_dir/second/Probe.app"
adhoc_first_bundle="$work_dir/adhoc-first/Probe.app"
adhoc_second_bundle="$work_dir/adhoc-second/Probe.app"
make_bundle "$first_bundle" "$first_version" "$work_dir/probe-a"
make_bundle "$second_bundle" "$second_version" "$work_dir/probe-b"
make_bundle "$adhoc_first_bundle" "$first_version" "$work_dir/probe-a"
make_bundle "$adhoc_second_bundle" "$second_version" "$work_dir/probe-b"
codesign --force --timestamp=none --sign - "$adhoc_first_bundle"
codesign --force --timestamp=none --sign - "$adhoc_second_bundle"

first_sign_status=0
first_sign_output="$(codesign --force --timestamp=none --sign "$identity_common_name" --keychain "$keychain_path" "$first_bundle" 2>&1)" || first_sign_status=$?
second_sign_status=0
second_sign_output="$(codesign --force --timestamp=none --sign "$identity_common_name" --keychain "$keychain_path" "$second_bundle" 2>&1)" || second_sign_status=$?

first_requirement="$(designated_requirement "$first_bundle" || true)"
second_requirement="$(designated_requirement "$second_bundle" || true)"
first_requirement_path="$work_dir/first-requirement.txt"
second_requirement_path="$work_dir/second-requirement.txt"
printf '%s\n' "$first_requirement" >"$first_requirement_path"
printf '%s\n' "$second_requirement" >"$second_requirement_path"

requirements_equal=false
if [ -n "$first_requirement" ] && [ "$first_requirement" = "$second_requirement" ]; then requirements_equal=true; fi

first_satisfies_second_status=0
first_satisfies_second_output="$(codesign --verify --strict -R "$first_requirement_path" "$second_bundle" 2>&1)" || first_satisfies_second_status=$?
second_satisfies_first_status=0
second_satisfies_first_output="$(codesign --verify --strict -R "$second_requirement_path" "$first_bundle" 2>&1)" || second_satisfies_first_status=$?

adhoc_first_requirement="$(designated_requirement "$adhoc_first_bundle" || true)"
adhoc_second_requirement="$(designated_requirement "$adhoc_second_bundle" || true)"
adhoc_first_cdhash="$(cdhash_of "$adhoc_first_bundle")"
adhoc_second_cdhash="$(cdhash_of "$adhoc_second_bundle")"
adhoc_requirement="cdhash H\"$adhoc_first_cdhash\""
adhoc_requirement_path="$work_dir/adhoc-requirement.txt"
printf '%s\n' "$adhoc_requirement" >"$adhoc_requirement_path"
adhoc_accepts_first_status=0
adhoc_accepts_first_output="$(codesign --verify --strict -R "$adhoc_requirement_path" "$adhoc_first_bundle" 2>&1)" || adhoc_accepts_first_status=$?
adhoc_accepts_second_status=0
adhoc_accepts_second_output="$(codesign --verify --strict -R "$adhoc_requirement_path" "$adhoc_second_bundle" 2>&1)" || adhoc_accepts_second_status=$?

gatekeeper_status=0
gatekeeper_output="$(spctl --assess --type execute --verbose=4 "$first_bundle" 2>&1)" || gatekeeper_status=$?

trust_removal_status=0
security remove-trusted-cert "$certificate_path" >/dev/null 2>&1 || trust_removal_status=$?
restore_keychain_search_list
keychain_delete_status=0
if [ -e "$keychain_path" ]; then security delete-keychain "$keychain_path" >/dev/null 2>&1 || keychain_delete_status=$?; fi
trust_after_cleanup_status=0
security verify-cert -c "$certificate_path" -p codeSign -q >/dev/null 2>&1 || trust_after_cleanup_status=$?

keychain_deleted=false
if [ ! -e "$keychain_path" ]; then keychain_deleted=true; fi
search_list_restored=true
if security list-keychains -d user | grep -F "$keychain_path" >/dev/null; then search_list_restored=false; fi

failures=()
[ "$trust_install_status" -eq 0 ] || failures+=("codesign identity trust installation failed")
[ "$first_sign_status" -eq 0 ] || failures+=("signing the first bundle with the probe identity failed")
[ "$second_sign_status" -eq 0 ] || failures+=("signing the second bundle with the probe identity failed")
[ "$requirements_equal" = "true" ] || failures+=("the two probe bundles have different designated requirements")
[ "$first_satisfies_second_status" -eq 0 ] || failures+=("the first designated requirement does not accept the second bundle")
[ "$second_satisfies_first_status" -eq 0 ] || failures+=("the second designated requirement does not accept the first bundle")
[ "$adhoc_accepts_first_status" -eq 0 ] || failures+=("the content-hash control requirement does not accept the bundle it came from")
[ "$adhoc_accepts_second_status" -ne 0 ] || failures+=("the content-hash control requirement accepted a different bundle")
[ "$trust_after_cleanup_status" -ne 0 ] || failures+=("the probe identity is still trusted after cleanup")
[ "$keychain_deleted" = "true" ] || failures+=("the probe keychain still exists after cleanup")
[ "$search_list_restored" = "true" ] || failures+=("the keychain search list still names the probe keychain")

mkdir -p "$(dirname "$report_path")"
{
  printf '{\n'
  printf '  "runner": {\n'
  printf '    "os": "%s",\n' "$(json_escape "${RUNNER_OS:-}")"
  printf '    "environment": "%s",\n' "$(json_escape "${RUNNER_ENVIRONMENT:-}")"
  printf '    "image": "%s",\n' "$(json_escape "${ImageOS:-}")"
  printf '    "runId": "%s",\n' "$(json_escape "${GITHUB_RUN_ID:-}")"
  printf '    "sha": "%s"\n' "$(json_escape "${GITHUB_SHA:-}")"
  printf '  },\n'
  printf '  "identity": {\n'
  printf '    "commonName": "%s",\n' "$(json_escape "$identity_common_name")"
  printf '    "trustDomain": "user",\n'
  printf '    "trustPolicy": "codeSign",\n'
  printf '    "trustResult": "trustRoot",\n'
  printf '    "trustInstallStatus": %d,\n' "$trust_install_status"
  printf '    "trustInstallOutput": "%s",\n' "$(json_escape "$trust_install_output")"
  printf '    "findIdentityOutput": "%s"\n' "$(json_escape "$find_identity_output")"
  printf '  },\n'
  printf '  "selfSigned": {\n'
  printf '    "first": {\n'
  printf '      "path": "first/Probe.app",\n'
  printf '      "version": "%s",\n' "$(json_escape "$first_version")"
  printf '      "signStatus": %d,\n' "$first_sign_status"
  printf '      "signOutput": "%s",\n' "$(json_escape "$first_sign_output")"
  printf '      "designatedRequirement": "%s"\n' "$(json_escape "$first_requirement")"
  printf '    },\n'
  printf '    "second": {\n'
  printf '      "path": "second/Probe.app",\n'
  printf '      "version": "%s",\n' "$(json_escape "$second_version")"
  printf '      "signStatus": %d,\n' "$second_sign_status"
  printf '      "signOutput": "%s",\n' "$(json_escape "$second_sign_output")"
  printf '      "designatedRequirement": "%s"\n' "$(json_escape "$second_requirement")"
  printf '    },\n'
  printf '    "requirementsEqual": %s,\n' "$requirements_equal"
  printf '    "firstSatisfiesSecondRequirementStatus": %d,\n' "$first_satisfies_second_status"
  printf '    "firstSatisfiesSecondRequirementOutput": "%s",\n' "$(json_escape "$first_satisfies_second_output")"
  printf '    "secondSatisfiesFirstRequirementStatus": %d,\n' "$second_satisfies_first_status"
  printf '    "secondSatisfiesFirstRequirementOutput": "%s"\n' "$(json_escape "$second_satisfies_first_output")"
  printf '  },\n'
  printf '  "contentHashControl": {\n'
  printf '    "firstCdhash": "%s",\n' "$(json_escape "$adhoc_first_cdhash")"
  printf '    "secondCdhash": "%s",\n' "$(json_escape "$adhoc_second_cdhash")"
  printf '    "firstEmbeddedDesignatedRequirement": "%s",\n' "$(json_escape "$adhoc_first_requirement")"
  printf '    "secondEmbeddedDesignatedRequirement": "%s",\n' "$(json_escape "$adhoc_second_requirement")"
  printf '    "requirement": "%s",\n' "$(json_escape "$adhoc_requirement")"
  printf '    "acceptsFirstBundleStatus": %d,\n' "$adhoc_accepts_first_status"
  printf '    "acceptsFirstBundleOutput": "%s",\n' "$(json_escape "$adhoc_accepts_first_output")"
  printf '    "acceptsSecondBundleStatus": %d,\n' "$adhoc_accepts_second_status"
  printf '    "acceptsSecondBundleOutput": "%s"\n' "$(json_escape "$adhoc_accepts_second_output")"
  printf '  },\n'
  printf '  "gatekeeperAssessment": {\n'
  printf '    "status": %d,\n' "$gatekeeper_status"
  printf '    "output": "%s"\n' "$(json_escape "$gatekeeper_output")"
  printf '  },\n'
  printf '  "cleanup": {\n'
  printf '    "trustRemovalStatus": %d,\n' "$trust_removal_status"
  printf '    "keychainDeleteStatus": %d,\n' "$keychain_delete_status"
  printf '    "verifyCertAfterCleanupStatus": %d,\n' "$trust_after_cleanup_status"
  printf '    "keychainDeleted": %s,\n' "$keychain_deleted"
  printf '    "searchListRestored": %s\n' "$search_list_restored"
  printf '  },\n'
  printf '  "notEquivalentTo": [\n'
  printf '    "an Electron or Squirrel.Mac update check of a real download",\n'
  printf '    "a Gatekeeper assessment of a quarantined download",\n'
  printf '    "TCC permission retention across an update",\n'
  printf '    "a rollback to an earlier signed build"\n'
  printf '  ],\n'
  printf '  "failures": ['
  separator=""
  for failure in ${failures[@]+"${failures[@]}"}; do
    printf '%s\n    "%s"' "$separator" "$(json_escape "$failure")"
    separator=","
  done
  printf '\n  ]\n'
  printf '}\n'
} >"$report_path"

printf 'Designated requirement of the first self-signed bundle: %s\n' "$first_requirement"
printf 'Designated requirement of the second self-signed bundle: %s\n' "$second_requirement"
printf 'Self-signed requirements equal: %s\n' "$requirements_equal"
printf 'Content-hash control accepts its own bundle: %d\n' "$adhoc_accepts_first_status"
printf 'Content-hash control accepts the other bundle: %d\n' "$adhoc_accepts_second_status"
printf 'Gatekeeper assessment status: %d\n' "$gatekeeper_status"
printf 'Report: %s\n' "$report_path"

if [ "${#failures[@]}" -gt 0 ]; then
  for failure in "${failures[@]}"; do printf '::error::%s\n' "$failure" >&2; done
  exit 1
fi
