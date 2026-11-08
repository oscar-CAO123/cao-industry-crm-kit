// Masks key values in a stream. Reads the values from fd 3 (NUL-separated), never
// from argv or the environment, then copies stdin to stdout line by line with every
// value, its base64 form and its URL-encoded form replaced.
import Foundation

let marker = "<concealed by op-scoped>"
let raw = FileHandle(fileDescriptor: 3, closeOnDealloc: true).readDataToEndOfFile()
var secrets = Set<String>()
for part in raw.split(separator: 0) {
    guard let s = String(data: Data(part), encoding: .utf8), s.count >= 4 else { continue }
    secrets.insert(s)
    secrets.insert(Data(s.utf8).base64EncodedString())
    secrets.insert(Data(s.utf8).base64EncodedString().trimmingCharacters(in: CharacterSet(charactersIn: "=")))
    if let u = s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) { secrets.insert(u) }
}
let ordered = secrets.sorted { $0.count > $1.count }

while let line = readLine(strippingNewline: false) {
    var out = line
    for s in ordered where out.contains(s) { out = out.replacingOccurrences(of: s, with: marker) }
    FileHandle.standardOutput.write(out.data(using: .utf8)!)
}
