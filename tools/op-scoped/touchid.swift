// Asks for Touch ID. Exits 0 only if the fingerprint matches.
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "unlock the 1Password vault"
let context = LAContext()
var error: NSError?

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
    fail("Touch ID unavailable: \(error?.localizedDescription ?? "unknown")", 2)
}

let done = DispatchSemaphore(value: 0)
var ok = false
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, err in
    ok = success
    if !success { FileHandle.standardError.write("Touch ID failed: \(err?.localizedDescription ?? "unknown")\n".data(using: .utf8)!) }
    done.signal()
}
done.wait()
exit(ok ? 0 : 1)
