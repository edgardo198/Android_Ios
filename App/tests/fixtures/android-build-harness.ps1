$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$buildTestTokens = $null
$buildTestErrors = $null
$buildTestAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:CHATLOCAL_TEST_BUILD_SCRIPT, [ref]$buildTestTokens, [ref]$buildTestErrors)
if ($buildTestErrors.Count) { throw ($buildTestErrors | Out-String) }
foreach ($buildTestFunction in $buildTestAst.FindAll({
    param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $false)) {
    . ([scriptblock]::Create($buildTestFunction.Extent.Text))
}

if ($env:CHATLOCAL_TEST_BUILD_CASE -eq 'validation') {
    $valid = @(Resolve-ApiBuildUrl 'http://192.168.0.107:8000/'; Resolve-ApiBuildUrl 'https://chat.example.org')
    $invalid = @('file:///api', 'api.example.org', 'http://alice:secret@example.org', 'http://@example.org',
        'https://example.org?token=secret', 'https://example.org?', 'https://example.org#',
        'https://example.org/a b', 'http://example.org\path', 'http://example.org:0', 'http://')
    $rejected = 0
    foreach ($url in $invalid) { try { $null = Resolve-ApiBuildUrl $url } catch { $rejected++ } }
    Write-Output ('ANDROID_BUILD_RESULT=' + (@{
        valid = $valid; rejected = $rejected; total = $invalid.Count; empty = Resolve-ApiBuildUrl ''
    } | ConvertTo-Json -Compress))
    exit 0
}

$appDirectory = Join-Path $env:CHATLOCAL_TEST_BUILD_DIRECTORY 'App'
$androidDirectory = Join-Path $appDirectory 'android'
$isRelease = $env:CHATLOCAL_TEST_BUILD_CASE -ne 'debug'
$buildVariant = if ($isRelease) { 'Release' } else { 'Debug' }
$variantDirectory = $buildVariant.ToLowerInvariant()
$apkFixtureDirectory = Join-Path $androidDirectory "app/build/outputs/apk/$variantDirectory"
[System.IO.Directory]::CreateDirectory($apkFixtureDirectory) | Out-Null
[System.IO.File]::WriteAllText((Join-Path $androidDirectory 'gradlew.bat'), 'fixture, never executed')
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$fixtureArchive = [System.IO.Compression.ZipFile]::Open(
    (Join-Path $apkFixtureDirectory "app-$variantDirectory.apk"), [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $fixtureEntries = @(
        'lib/arm64-v8a/libreactnative.so', 'lib/arm64-v8a/libhermesvm.so', 'lib/arm64-v8a/libjingle_peerconnection_so.so',
        'lib/armeabi-v7a/libreactnative.so', 'lib/armeabi-v7a/libhermesvm.so')
    if ($env:CHATLOCAL_TEST_BUILD_CASE -notin @('no-bundle', 'debug', 'empty-bundle')) {
        $fixtureEntries += 'assets/index.android.bundle'
    }
    if ($env:CHATLOCAL_TEST_BUILD_CASE -eq 'empty-bundle') {
        $null = $fixtureArchive.CreateEntry('assets/index.android.bundle')
    }
    if ($env:CHATLOCAL_TEST_BUILD_CASE -ne 'missing-abi') {
        $fixtureEntries += 'lib/armeabi-v7a/libjingle_peerconnection_so.so'
    }
    foreach ($name in $fixtureEntries) {
        $stream = $fixtureArchive.CreateEntry($name).Open()
        try { $stream.Write([byte[]](1, 2, 3, 4), 0, 4) } finally { $stream.Dispose() }
    }
} finally { $fixtureArchive.Dispose() }

$runtimeJava = [pscustomobject]@{ Directory = 'fixture-jdk' }
$java17 = $runtimeJava
$resolvedSdk = 'fixture-sdk'
$resolvedApiUrl = 'http://192.168.0.107:8000'
$nodeExecutable = 'fixture-node'
$expoCli = 'fixture-expo-cli'
$buildArchitectures = 'arm64-v8a,armeabi-v7a'
$Workers = 2
$MetroPort = 8081
$SkipPrebuild = $false
$Offline = $false
$Install = $true
$adbExecutable = 'fixture-adb'
$selectedDevice = 'fixture-phone'
$buildCommands = [System.Collections.Generic.List[object]]::new()
$installCommands = [System.Collections.Generic.List[object]]::new()
function Invoke-BuildCommand([string]$Executable, [string[]]$Arguments) {
    $buildCommands.Add(@{
        executable = $Executable; arguments = $Arguments; nodeEnv = $env:NODE_ENV; babelEnv = $env:BABEL_ENV;
        apiUrl = $env:EXPO_PUBLIC_API_URL; inlineEnv = $env:EXPO_NO_CLIENT_ENV_VARS
    })
    if ($env:CHATLOCAL_TEST_BUILD_CASE -eq 'prebuild-failure') { throw 'fixture prebuild failure' }
}
function Resolve-InstallDevice([string]$Executable, [string]$RequestedSerial) { return 'fixture-phone' }
function Invoke-AdbCaptured([string]$Executable, [string[]]$Arguments, [string]$FailureMessage) {
    $installCommands.Add($Arguments)
    return 'Success'
}
$environmentNames = @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'PATH', 'CI',
    'NODE_ENV', 'BABEL_ENV', 'EXPO_PUBLIC_API_URL', 'EXPO_NO_CLIENT_ENV_VARS')
$env:NODE_ENV = 'original-node-env'
$env:BABEL_ENV = 'original-babel-env'
$env:EXPO_PUBLIC_API_URL = 'https://original.example.org'
$env:EXPO_NO_CLIENT_ENV_VARS = '1'
$before = @{}
foreach ($name in $environmentNames) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$savedEnvironment = $before.Clone()
$failure = $null
# Execute only the final build block with injected tool stubs and synthetic APKs.
# No Expo, Gradle, ADB, native compilation, phone or application database is touched.
try { . ([scriptblock]::Create($buildTestAst.EndBlock.Statements[-1].Extent.Text)) } catch { $failure = $_.Exception.Message }
$restored = $true
foreach ($name in $environmentNames) {
    if ($before[$name] -cne [Environment]::GetEnvironmentVariable($name, 'Process')) { $restored = $false }
}
Write-Output ('ANDROID_BUILD_RESULT=' + (@{
    commands = @($buildCommands.ToArray()); installations = @($installCommands.ToArray());
    restored = $restored; failure = $failure
} | ConvertTo-Json -Compress -Depth 8))
