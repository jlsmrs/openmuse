// Renders the agent's avatar: the stock capybara variant, or the stored
// custom avatar image when one is set. A custom avatar is never bundled
// and never fetched by a bare path: the component asks the server for a
// fresh 15-minute signed URL (/api/identity/avatar). If that image fails
// to load (for example the URL expired), it refetches once, then falls
// back to the stock mascot rather than showing a broken image.
import { useCallback, useEffect, useState } from "react";
import { Image, View } from "react-native";
import type { AgentIdentity } from "../../../packages/domain/src/agent";
import { Mascot } from "./ui";
import { useWorkspace } from "./workspace";

export function AgentAvatar({ identity, size = 42 }: { identity?: AgentIdentity; size?: number }) {
  const { api } = useWorkspace();
  const [url, setUrl] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const custom = identity?.avatar === "custom" ? identity.customAvatar : undefined;
  const fetchUrl = useCallback(() => {
    api
      .request<{ url: string | null }>("/api/identity/avatar")
      .then((res) => setUrl(res.url ?? undefined))
      .catch(() => setFailed(true));
  }, [api]);
  useEffect(() => {
    if (!custom) {
      setUrl(undefined);
      setFailed(false);
      setRetried(false);
      return;
    }
    fetchUrl();
  }, [custom?.source, custom?.id, fetchUrl]);
  if (!custom || failed || !url)
    return (
      <Mascot
        size={size}
        variant={identity?.avatar === "custom" ? "sky" : (identity?.avatar ?? "sky")}
      />
    );
  return (
    <View
      accessibilityLabel="Custom avatar"
      style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden" }}
    >
      <Image
        source={{ uri: url }}
        resizeMode="cover"
        style={{ width: size, height: size }}
        accessible={false}
        onError={() => {
          if (!retried) {
            setRetried(true);
            fetchUrl();
          } else {
            setFailed(true);
          }
        }}
      />
    </View>
  );
}
