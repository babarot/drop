// Copying a value received from the server.
//
// clipboard.writeText requires transient activation, so calling it after awaiting a fetch
// fails with NotAllowedError in Safari and others (this constraint is why copies of values
// built locally are written synchronously. See handlePublishCopy in App.tsx).
//
// The workaround is to reserve the write right under the click by passing a Promise to
// ClipboardItem. The link to the user action survives even if the value arrives later.
// This is the mechanism Safari officially provides, and Chrome / Firefox accept it per spec.
//
// Where it is not accepted this returns false, so the caller should fall back to asking the
// user to press again (on the second click the value is at hand and can be written synchronously).
export async function copyWhenReady(text: Promise<string>): Promise<boolean> {
  try {
    const item = new ClipboardItem({
      'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })),
    })
    await navigator.clipboard.write([item])
    return true
  } catch {
    // Either ClipboardItem is missing, it does not accept a Promise, or fetching the value failed.
    // The caller tells which by looking at the original Promise
    return false
  }
}
