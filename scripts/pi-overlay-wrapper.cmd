@echo off
rem Launcher do overlay no Windows: a mesma semantica de scripts/pi-overlay-wrapper.sh.
rem
rem   pi overlay-update [args]   -> node <bundle>\scripts\pi-overlay-update.mjs [args]
rem   pi overlay-rollback [args] -> node <bundle>\scripts\pi-overlay-update.mjs --rollback [args]
rem   pi overlay-status [args]   -> node <bundle>\scripts\pi-overlay-update.mjs --status [args]
rem   pi overlay-gc [args]       -> node <bundle>\scripts\pi-overlay-update.mjs --gc [args]
rem   pi update [...]            -> updater (self), delegacao ao Pi, ou os dois (--all)
rem   qualquer outra coisa       -> launcher do MARK II quando houve opt-in, senao a CLI de `current`
rem
rem __OVERLAY_REPO__ e substituido pelo caminho do bundle instalado quando o updater renderiza
rem este arquivo; PI_OVERLAY_REPO e PI_OVERLAY_STORE continuam mandando mais, como no POSIX.
rem
rem `exit /b` sem valor preserva o ERRORLEVEL do ultimo comando: dentro de um bloco entre
rem parenteses, %ERRORLEVEL% seria expandido na leitura do bloco, isto e, antes de o comando rodar.
setlocal EnableExtensions DisableDelayedExpansion

if defined PI_OVERLAY_REPO (set "OVERLAY_REPO=%PI_OVERLAY_REPO%") else (set "OVERLAY_REPO=__OVERLAY_REPO__")
if defined PI_OVERLAY_STORE (set "STORE=%PI_OVERLAY_STORE%") else (set "STORE=%USERPROFILE%\.local\share\pi-overlay")
set "UPDATER=%OVERLAY_REPO%\scripts\pi-overlay-update.mjs"
set "MARK_II_CONFIG=%STORE%\mark-ii\config.json"
set "MARK_II_LAUNCHER=%OVERLAY_REPO%\scripts\mark-ii-launch.mjs"

rem `npm install --global --prefix X` grava X\pi.cmd no Windows (sem bin\).
set "ACTIVE_PI=%STORE%\current\pi.cmd"
if not exist "%ACTIVE_PI%" set "ACTIVE_PI=%STORE%\current\bin\pi.cmd"

rem Tudo depois do primeiro argumento, preservando o quoting original.
set "REST="
for /f "tokens=1,*" %%a in ("%*") do set "REST=%%b"

if /i "%~1"=="overlay-update" goto :overlay_update
if /i "%~1"=="overlay-rollback" goto :overlay_rollback
if /i "%~1"=="overlay-status" goto :overlay_status
if /i "%~1"=="overlay-gc" goto :overlay_gc
if /i "%~1"=="update" goto :update
goto :normal

rem Caminho normal, depois do dispatch de manutencao: o MARK II entra aqui e somente com opt-in
rem explicito (o arquivo de configuracao do store). MARK_II_DISABLED=1 e o escape documentado;
rem quem valida artefato/broker/config e falha fechado e o launcher, nunca este .cmd.
:normal
if defined MARK_II_DISABLED (if /i "%MARK_II_DISABLED%"=="1" goto :delegate)
if not exist "%MARK_II_CONFIG%" goto :delegate
if not exist "%MARK_II_LAUNCHER%" goto :markii_missing
node "%MARK_II_LAUNCHER%" --store "%STORE%" -- %*
exit /b

:markii_missing
echo MARK II esta habilitado em "%MARK_II_CONFIG%", mas "%MARK_II_LAUNCHER%" nao existe neste bundle. 1>&2
echo Reinstale o overlay (node "%UPDATER%") ou rode sem MARK II: set MARK_II_DISABLED=1 1>&2
exit /b 1

:overlay_update
node "%UPDATER%" %REST%
exit /b

:overlay_rollback
node "%UPDATER%" --rollback %REST%
exit /b

:overlay_status
node "%UPDATER%" --status %REST%
exit /b

:overlay_gc
node "%UPDATER%" --gc %REST%
exit /b

:delegate
if not exist "%ACTIVE_PI%" goto :missing
call "%ACTIVE_PI%" %*
exit /b

:missing
echo Pi overlay is not installed; run: node "%UPDATER%" 1>&2
exit /b 1

:update
set "MODE=self"
set "EXTRA=--extensions"
shift
:update_scan
rem SHIFT nao mexe em %*, entao a delegacao continua recebendo a linha inteira.
if "%~1"=="" goto :update_done
if /i "%~1"=="--all" (
	set "MODE=all"
	goto :update_next
)
if /i "%~1"=="self" goto :update_next
if /i "%~1"=="pi" goto :update_next
if /i "%~1"=="--self" goto :update_next
if /i "%~1"=="--force" (
	set "EXTRA=%EXTRA% --force"
	goto :update_next
)
if /i "%~1"=="--approve" (
	set "EXTRA=%EXTRA% --approve"
	goto :update_next
)
if /i "%~1"=="--no-approve" (
	set "EXTRA=%EXTRA% --no-approve"
	goto :update_next
)
set "MODE=delegate"
:update_next
shift
goto :update_scan

:update_done
if /i "%MODE%"=="delegate" goto :delegate
if /i "%MODE%"=="all" goto :update_all
node "%UPDATER%"
exit /b

:update_all
node "%UPDATER%"
if errorlevel 1 exit /b
if not exist "%ACTIVE_PI%" goto :missing
call "%ACTIVE_PI%" update %EXTRA%
exit /b
