import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { API_URL } from "./api";
import { ErrorNotice } from "./ui";
// `title` labels the web iframe; the native WebView has no equivalent.
// `sandboxed` is accepted so the shared call site typechecks on both
// platforms, but a native WebView has no iframe sandbox, so it has no effect
// here. Navigation is restricted to the API origin instead (the console is
// served from the API), so the view cannot wander to another site.
export default function BrowserConsole({
  url,
}: {
  url: string;
  title?: string;
  sandboxed?: boolean;
}) {
  const [error, setError] = useState("");
  return (
    <View>
      <ErrorNotice error={error} />
      <WebView
        source={{ uri: url }}
        originWhitelist={[new URL(API_URL).origin]}
        onError={(event) => setError(event.nativeEvent.description)}
        style={{ height: 520, borderRadius: 12 }}
      />
    </View>
  );
}
