import AppKit
import WebKit

private struct Failure: Error { let reason: String; init(_ reason: String) { self.reason = reason } }

@main struct InspectorProbe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            do { try await check(URL(string: CommandLine.arguments[1])!); exit(0) }
            catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1) }
        }
        app.run()
    }

    @MainActor static func check(_ base: URL) async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let frame = NSRect(x: 0, y: 0, width: 1000, height: 650)
        let web = WKWebView(frame: frame, configuration: configuration)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.setFrameOrigin(NSPoint(x: -16000, y: -16000))
        window.orderBack(nil)
        defer { window.close() }
        func js(_ s: String) async throws -> Any? { try await web.evaluateJavaScript(s) }
        for page in ["", "machine.html"] {
            let url = page.isEmpty ? base : base.appendingPathComponent(page)
            web.loadHTMLString("<iframe style='border:0;width:340px;height:600px' src='\(url.absoluteString)'></iframe>", baseURL: base)
            let ready = page.isEmpty ? ".job.selected" : ".sc-node.active"
            for _ in 0..<125 {
                if (try? await js("!!document.querySelector('iframe')?.contentDocument?.querySelector('\(ready)')")) as? Bool == true { break }
                try await Task.sleep(for: .milliseconds(40))
            }
            _ = try await js("window.f=document.querySelector('iframe');window.d=f.contentDocument;window.b=d.querySelector('.bar button[aria-controls]');window.p=d.getElementById(b.getAttribute('aria-controls'));void 0")
            for (width, open) in [(340,true),(940,true),(720,true),(720,false),(721,false),(940,true)] {
                let prior = try await js("b.getAttribute('aria-expanded')") as? String
                _ = try await js("f.style.width='\(width)px';void 0")
                try await Task.sleep(for: .milliseconds(120))
                guard try await js("f.contentWindow.innerWidth") as? Int == width,
                      try await js("b.getAttribute('aria-expanded')") as? String == prior else { throw Failure("Resize changed panel state") }
                if (prior == "true") != open { _ = try await js("b.click()") }
                let geometry = """
                (()=>{const r=b.querySelector('svg').getBoundingClientRect(),fbox=f.getBoundingClientRect(),
                    c=d.querySelector('#workbench').firstElementChild.getBoundingClientRect(),a=p.getBoundingClientRect();
                    return [fbox.x+r.x,fbox.y+r.y,r.width,r.height,p.hidden?'closed':a.top>=c.bottom?'bottom':a.left>=c.right?'right':'unknown'];})()
                """
                guard let g = try await js(geometry) as? [Any], g.count == 5, let x = g[0] as? Double, let y = g[1] as? Double,
                      let w = g[2] as? Double, let h = g[3] as? Double, w > 0, let dock = g[4] as? String else { throw Failure("Missing toggle") }
                let snapshot = WKSnapshotConfiguration()
                snapshot.rect = NSRect(x: x, y: y, width: w, height: h)
                snapshot.snapshotWidth = 128
                let image = try await web.takeSnapshot(configuration: snapshot)
                guard let data = image.tiffRepresentation, let pixels = NSBitmapImageRep(data: data) else { throw Failure("Missing painted icon") }
                func luminance(_ x: Double, _ y: Double) throws -> Double {
                    guard let c = pixels.colorAt(x: Int(x*Double(pixels.pixelsWide)), y: Int(y*Double(pixels.pixelsHigh)))?.usingColorSpace(.deviceRGB)
                    else { throw Failure("No RGB pixel") }
                    return 0.213*c.redComponent + 0.715*c.greenComponent + 0.072*c.blueComponent
                }
                // Sample each possible divider away from both the outline and their intersection.
                let bg = try luminance(0.38,0.38), bottom = try abs(luminance(0.35,0.60)-bg), right = try abs(luminance(0.60,0.35)-bg)
                let painted = abs(bottom-right)<0.19 ? "unknown" : bottom>right ? "bottom" : "right", expected = width<=720 ? "bottom" : "right"
                guard painted == expected, dock == (open ? expected : "closed") else {
                    throw Failure("\(page.isEmpty ? "work graph" : "state explorer") at \(width)px: inspector \(dock), painted \(painted), expected \(expected)")
                }
            }
        }
    }
}
