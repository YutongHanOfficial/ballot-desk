// Square headshots for candidate photos (macOS: Vision finds the face, ImageIO writes the JPEG).
// Reads "in<TAB>out" lines on stdin and prints one JSON line per image:
//   {"in": ..., "ok": true, "face": [x, y, w, h]}  or  {"in": ..., "ok": false, "reason": ...}
// Usage: swift pipeline/facecrop.swift 192 < jobs.tsv     (192 = output size in pixels)
// A photo is kept only with one clear face that is big enough to crop sharply; anything else is reported,
// never guessed, so a logo, a group shot or a tiny figure never ends up beside a candidate's name.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let size = Int(CommandLine.arguments.dropFirst().first ?? "") ?? 192
let minFace = 56.0          // face height in source pixels, so the crop is not blown up past ~1.5x
let framing = 2.6           // crop side as a multiple of the face box (eyebrows to chin): head and shoulders
let faceAt = 0.5            // where the face centre sits, from the top of the crop (centred for round frames)

func report(_ dict: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  fflush(stdout)
}

func load(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                               kCGImageSourceCreateThumbnailWithTransform: true,   // honour EXIF rotation
                               kCGImageSourceThumbnailMaxPixelSize: 1600]
  return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
}

func crop(_ path: String, to out: String) {
  guard let img = load(path) else { return report(["in": path, "ok": false, "reason": "unreadable"]) }
  let W = Double(img.width), H = Double(img.height)
  let req = VNDetectFaceRectanglesRequest()
  do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) } catch {
    return report(["in": path, "ok": false, "reason": "vision: \(error.localizedDescription)"])
  }
  // Vision boxes are normalised with the origin at the bottom left; flip to pixels from the top left.
  let faces = (req.results ?? []).map { f -> CGRect in
    let b = f.boundingBox
    return CGRect(x: b.minX * W, y: (1 - b.maxY) * H, width: b.width * W, height: b.height * H)
  }.sorted { $0.width * $0.height > $1.width * $1.height }
  guard let face = faces.first else { return report(["in": path, "ok": false, "reason": "no face"]) }
  if faces.count > 1, faces[1].width * faces[1].height > 0.45 * face.width * face.height {
    return report(["in": path, "ok": false, "reason": "\(faces.count) faces"])
  }
  if Double(face.height) < minFace { return report(["in": path, "ok": false, "reason": "face too small (\(Int(face.height))px)"]) }

  var side = min(Double(max(face.width, face.height)) * framing, W, H)
  side = max(side, min(W, H, Double(face.height) * 1.6))
  let cx = Double(face.midX), cy = Double(face.midY)
  let left = min(max(0, cx - side / 2), W - side)
  let top = min(max(0, cy - side * faceAt), H - side)
  guard let part = img.cropping(to: CGRect(x: left.rounded(), y: top.rounded(), width: side.rounded(), height: side.rounded())),
        let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { return report(["in": path, "ok": false, "reason": "crop failed"]) }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))   // transparent PNGs get a white backdrop
  ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
  ctx.interpolationQuality = .high
  ctx.draw(part, in: CGRect(x: 0, y: 0, width: size, height: size))
  guard let result = ctx.makeImage(),
        let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
  else { return report(["in": path, "ok": false, "reason": "encode failed"]) }
  CGImageDestinationAddImage(dest, result, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return report(["in": path, "ok": false, "reason": "write failed"]) }
  report(["in": path, "ok": true, "face": [face.minX / W, face.minY / H, face.width / W, face.height / H].map { ($0 * 1000).rounded() / 1000 },
          "scale": ((Double(size) / side) * 100).rounded() / 100])
}

while let line = readLine() {
  let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
  if parts.count == 2 { crop(parts[0], to: parts[1]) }
}
