package observercontract

import (
    "bytes"
    "encoding/json"
    "os"
    "regexp"
    "strings"
    "testing"
    "text/template"
)

// Executes the actual Python producer template under Go's strict missing-key mode.
func TestActualInspectTemplateWithMissingHealth(t *testing.T) {
    source, err := os.ReadFile("collector.py")
    if err != nil { t.Fatal(err) }
    match := regexp.MustCompile(`(?m)^TEMPLATE = r'(.*)'$`).FindSubmatch(source)
    if len(match) != 2 { t.Fatal("collector template not found") }
    actual := string(match[1])
    if strings.Contains(actual, ".State.Health") || !strings.Contains(actual, `index .State "Health"`) {
        t.Fatal("Health must use index, including the nil guard")
    }
    jsonValue := func(value interface{}) (string, error) { encoded, err := json.Marshal(value); return string(encoded), err }
    compiled, err := template.New("docker-inspect").Option("missingkey=error").Funcs(template.FuncMap{"json": jsonValue}).Parse(actual)
    if err != nil { t.Fatal(err) }
    for _, mode := range []string{"absent", "nil", "healthy", "unhealthy"} {
        t.Run(mode, func(t *testing.T) {
            state := map[string]interface{}{"Status": "running", "StartedAt": "2026-11-14T10:00:00Z", "FinishedAt": "0001-01-01T00:00:00Z"}
            if mode == "nil" { state["Health"] = nil }
            if mode == "healthy" || mode == "unhealthy" { state["Health"] = map[string]interface{}{"Status": mode} }
            input := map[string]interface{}{"Id": strings.Repeat("a", 64), "Name": "/worker", "Config": map[string]interface{}{"Image": "worker:1", "Labels": map[string]interface{}{}}, "State": state, "RestartCount": 0}
            var output bytes.Buffer
            if err := compiled.Execute(&output, input); err != nil { t.Fatal(err) }
            var value map[string]interface{}
            if err := json.Unmarshal(output.Bytes(), &value); err != nil { t.Fatal(err) }
            if mode == "absent" || mode == "nil" {
                if value["healthStatus"] != nil { t.Fatal("missing Health must remain unknown") }
            } else if value["healthStatus"] != mode { t.Fatal("wrong explicit health status") }
            if len(value) != 9 { t.Fatal("inspect whitelist changed") }
        })
    }
}
