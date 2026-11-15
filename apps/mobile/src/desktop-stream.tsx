import { ExternalLink, RefreshCw } from "lucide-react-native";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Platform, Text, View } from "react-native";
import BrowserConsole from "./BrowserConsole";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Each URL request keeps the computer awake for 30 minutes; a visible stream repeats
// it every 2 minutes, for at most an hour.
const keepAwakeMs = 120000,
  keepAwakeLimitMs = 60 * 60000;

/** The live desktop stream URL of the running computer, kept fresh while shown. */
export function useDesktopStream(running: boolean) {
  const { api } = useWorkspace();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  // True once the one-hour keep-awake cap stops automatic refreshes; the
  // stream keeps showing the last URL until the user refreshes it.
  const [capped, setCapped] = useState(false);
  const sinceRef = useRef(Date.now());
  const loadRef = useRef<(force?: boolean) => void>(() => {});
  // Restart the hour and fetch a fresh URL after the cap is hit.
  const refresh = useCallback(() => {
    sinceRef.current = Date.now();
    setCapped(false);
    loadRef.current(true);
  }, []);
  useEffect(() => {
    if (!running) return;
    let alive = true,
      loaded = false,
      retry: ReturnType<typeof setTimeout> | undefined;
    const load = (force = false) => {
      if (!force && AppState.currentState !== "active") return;
      if (!force && Date.now() - sinceRef.current > keepAwakeLimitMs) {
        setCapped(true);
        return;
      }
      // The cap lifted (foreground return or manual refresh restarts the hour),
      // so the stream is refreshing again: the capped notice must go with it.
      setCapped(false);
      void api
        .request<{ url: string }>("/api/computer/desktop")
        .then((value) => {
          if (!alive) return;
          loaded = true;
          setUrl(value.url);
          setError("");
        })
        .catch((e) => {
          // A loaded stream survives a failed refresh; a first load shows the error and
          // retries shortly instead of waiting for the next refresh.
          if (!alive || loaded) return;
          setError(message(e));
          clearTimeout(retry);
          // Forced: until the first URL arrives, retry even while the app is hidden.
          retry = setTimeout(() => load(true), 5000);
        });
    };
    loadRef.current = load;
    load(true);
    const interval = setInterval(load, keepAwakeMs);
    // Returning to the app (e.g. from the externally opened desktop) restarts the hour.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      sinceRef.current = Date.now();
      load();
    });
    return () => {
      alive = false;
      clearInterval(interval);
      clearTimeout(retry);
      subscription.remove();
    };
  }, [api, running]);
  return { url, error, setError, capped, refresh };
}

/** Web embeds the stream; native opens it in the system browser. Memoized on its
 * props, so a parent re-render never remounts the VNC session. */
export const DesktopStream = memo(function DesktopStream({
  running,
  embed = true,
}: {
  running: boolean;
  /** False shows only the Open desktop button, also on web. */
  embed?: boolean;
}) {
  const embedded = embed && Platform.OS === "web";
  const { api } = useWorkspace();
  const { url, error, setError, capped, refresh } = useDesktopStream(running && embedded);
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    setError("");
    try {
      const target =
        embedded && url ? url : (await api.request<{ url: string }>("/api/computer/desktop")).url;
      await Linking.openURL(target);
    } catch (e) {
      setError(message(e));
    } finally {
      setOpening(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={error} />
      {embedded && !url && !error && <ActivityIndicator color={colors.blueDark} />}
      {!!url && embed && Platform.OS === "web" && (
        <BrowserConsole url={url} title="Computer desktop" sandboxed />
      )}
      {capped && (
        <View style={{ gap: 8 }}>
          <Text style={s.small}>
            The stream stopped refreshing after an hour. Refresh it to keep watching the live
            desktop.
          </Text>
          <Button icon={RefreshCw} onPress={() => refresh()}>
            Refresh stream
          </Button>
        </View>
      )}
      {running && (!embedded || !!url) && (
        <Button
          icon={ExternalLink}
          primary={Platform.OS !== "web"}
          disabled={opening}
          onPress={() => void open()}
        >
          {opening ? "Opening…" : "Open desktop"}
        </Button>
      )}
    </View>
  );
});
