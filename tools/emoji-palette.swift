import AppKit
import CoreGraphics

func dominant(_ ch: String) -> (Double, Double, Double)? {
    let size = CGFloat(96)
    let space = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8,
                              bytesPerRow: Int(size) * 4, space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    let font = NSFont(name: "Apple Color Emoji", size: size * 0.8) ?? NSFont.systemFont(ofSize: size * 0.8)
    let attrs: [NSAttributedString.Key: Any] = [.font: font]
    let str = NSAttributedString(string: ch, attributes: attrs)
    let sz = str.size()
    str.draw(at: NSPoint(x: (size - sz.width) / 2, y: (size - sz.height) / 2))
    NSGraphicsContext.restoreGraphicsState()

    guard let data = ctx.data else { return nil }
    let p = data.bindMemory(to: UInt8.self, capacity: Int(size) * Int(size) * 4)
    var counts: [UInt32: Int] = [:]
    for y in 0..<Int(size) {
        for x in 0..<Int(size) {
            let i = (y * Int(size) + x) * 4
            let r = p[i], g = p[i + 1], b = p[i + 2]
            // skip near-white background and near-black antialiasing
            if r > 245 && g > 245 && b > 245 { continue }
            if r < 12 && g < 12 && b < 12 { continue }
            let key = (UInt32(r) << 16) | (UInt32(g) << 8) | UInt32(b)
            counts[key, default: 0] += 1
        }
    }
    guard let top = counts.max(by: { $0.value < $1.value })?.key else { return nil }
    return (Double((top >> 16) & 0xFF), Double((top >> 8) & 0xFF), Double(top & 0xFF))
}

for ch in ["🟨", "🟦", "🟪", "🟩", "🟥", "🟧"] {
    if let c = dominant(ch) {
        print("\(ch) rgb(\(Int(c.0)), \(Int(c.1)), \(Int(c.2)))  #\(String(format: "%02X%02X%02X", Int(c.0), Int(c.1), Int(c.2)))")
    } else {
        print("\(ch) no colour found")
    }
}
