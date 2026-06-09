@echo off
REM Windows launcher for the trace-codex hook binary.
REM
REM Windows is not supported yet. This stub exits 0 so it never fails a Codex
REM turn; tracing simply does nothing on Windows for now. When Windows support
REM lands, this will mirror codex-hook.sh: detect arch, download the matching
REM codex-hook.exe from the GitHub release into %PLUGIN_ROOT%\bin, and exec it.
echo trace-codex: Windows support coming soon; tracing disabled this session.>&2
exit /b 0
