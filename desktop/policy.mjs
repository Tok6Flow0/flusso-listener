export function trustedFrame(event, window, origin) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === '/' && !url.search; } catch { return false; }
}
export function externalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'flusso.stream') throw new Error('External navigation refused.');
  return url.href;
}

export function reportDraftState(event, window, origin, args, guard) {
  if (!trustedFrame(event, window, origin) || args.length !== 1 || typeof args[0] !== 'boolean') return false;
  guard.reportDirty(args[0]);
  return true;
}

// Unknown renderer state is never treated as a saved draft. All exit effects
// (including update settings) belong inside the work callback, after consent.
export function createDraftExitGuard({ confirmDiscard }) {
  let dirty = null, approved = false, pending = false;
  return {
    reportDirty(value) {
      if (typeof value !== 'boolean') throw new Error('Invalid draft state.');
      dirty = value; approved = false;
    },
    invalidate() { dirty = null; approved = false; },
    isApproved: () => approved,
    async run(reason, work) {
      if (pending) return false;
      pending = true;
      try {
        approved = dirty === false || await confirmDiscard(reason, dirty === null) === true;
        if (!approved) return false;
        await work();
        return true;
      } catch (error) { approved = false; throw error; }
      finally { pending = false; }
    },
  };
}

// A stopped runtime cannot become an editable Journal again after an installer
// fails. Explain once, then exit; neither the updater nor this handler resumes it.
export function createStoppedUpdateFailureHandler({ isStopped, explain, quit }) {
  let handled = false;
  return {
    isHandled: () => handled,
    handle() {
      if (!isStopped() || handled) return false;
      handled = true;
      try { explain(); } finally { quit(); }
      return true;
    },
  };
}
