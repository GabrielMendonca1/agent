@echo off
rem Launcher do overlay no Windows: a mesma semantica de scripts/agent-wrapper.sh.
rem
rem   agent overlay-update [args]   -> node <bundle>\scripts\agent-update.mjs [args]
rem   agent overlay-rollback [args] -> node <bundle>\scripts\agent-update.mjs --rollback [args]
rem   agent overlay-status [args]   -> node <bundle>\scripts\agent-update.mjs --status [args]
rem   agent overlay-gc [args]       -> node <bundle>\scripts\agent-update.mjs --gc [args]
rem   agent update [...]            -> updater (self), delegacao ao Pi, ou os dois (--all)
rem   qualquer outra coisa       -> launcher do Agent quando houve opt-in, senao a CLI de `current`
rem
rem __OVERLAY_REPO__ e substituido pelo caminho do bundle instalado quando o updater renderiza
rem este arquivo; AGENT_REPO e AGENT_STORE continuam mandando mais, como no POSIX.
rem
rem `exit /b` sem valor preserva o ERRORLEVEL do ultimo comando: dentro de um bloco entre
rem parenteses, %ERRORLEVEL% seria expandido na leitura do bloco, isto e, antes de o comando rodar.
rem Perfil do Agent (settings, auth, sessoes): separado do %USERPROFILE%\.pi\agent do Pi/Mark.
if not defined PI_CODING_AGENT_DIR set "PI_CODING_AGENT_DIR=%USERPROFILE%\.agent"
setlocal EnableExtensions DisableDelayedExpansion

if defined AGENT_REPO (set "OVERLAY_REPO=%AGENT_REPO%") else (set "OVERLAY_REPO=__OVERLAY_REPO__")
if defined AGENT_STORE (set "STORE=%AGENT_STORE%") else (set "STORE=%USERPROFILE%\.local\share\agent")
set "UPDATER=%OVERLAY_REPO%\scripts\agent-update.mjs"
set "AGENT_CONFIG=%STORE%\runtime\config.json"
set "AGENT_LAUNCHER=%OVERLAY_REPO%\scripts\agent-launch.mjs"

rem `npm install --global --prefix X` grava X\pi.cmd no Windows (sem bin\).
set "ACTIVE_PI=%STORE%\current\pi.cmd"
if not exist "%ACTIVE_PI%" set "ACTIVE_PI=%STORE%\current\bin\pi.cmd"

rem Tudo depois do primeiro argumento, preservando o quoting original.
set "REST="
for /f "tokens=1,*" %%a in ("%*") do set "REST=%%b"

if /i "%~1"=="migrate-from-mark" goto :migrate_from_mark
if /i "%~1"=="overlay-update" goto :overlay_update
if /i "%~1"=="overlay-rollback" goto :overlay_rollback
if /i "%~1"=="overlay-status" goto :overlay_status
if /i "%~1"=="overlay-gc" goto :overlay_gc
if /i "%~1"=="update" goto :update
goto :normal

:normal
rem O helper tambem limpa os preloads herdados no opt-out e sem config.
if exist "%AGENT_LAUNCHER%" goto :agent_launch
if exist "%AGENT_CONFIG%" goto :agent_missing
goto :delegate
:agent_launch
node "%AGENT_LAUNCHER%" --store "%STORE%" -- %*
exit /b

:agent_missing
echo Agent esta habilitado em "%AGENT_CONFIG%", mas "%AGENT_LAUNCHER%" nao existe neste bundle. 1>&2
echo Reinstale o bundle com o launcher correspondente. 1>&2
exit /b 1

:migrate_from_mark
node "%OVERLAY_REPO%\scripts\migrate-from-mark.mjs" %REST%
exit /b

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
node "%UPDATER%" --install-artifact latest
exit /b

:update_all
node "%UPDATER%" --install-artifact latest
if errorlevel 1 exit /b
if not exist "%ACTIVE_PI%" goto :missing
call "%ACTIVE_PI%" update %EXTRA%
exit /b
