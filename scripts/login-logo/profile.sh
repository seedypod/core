# seedypod login logo. Written by scripts/install; every login shell sources it,
# sh included, so keep it POSIX and quiet. Only an interactive shell on a terminal
# gets past the first lines: ssh host cmd, scp, sftp, rsync, cron and systemd
# aren't login shells or have no terminal, and don't start anything here.
case $- in
  *i*)
    # tmux and screen start each pane as a login shell.
    if [ -t 0 ] && [ -t 1 ] && [ -z "${SEEDYPOD_LOGO_SHOWN:-}${TMUX:-}${STY:-}" ] \
      && [ -x /usr/local/share/seedypod/login-logo ]; then
      export SEEDYPOD_LOGO_SHOWN=1
      # A Ctrl-C the logo doesn't catch must not abort this shell's startup files.
      trap : INT
      /usr/local/share/seedypod/login-logo 2>/dev/null || :
      trap - INT
    fi
    ;;
esac
