import AppKit
import Darwin
import Foundation

private enum MacReportEvent: String, Codable {
    case online
    case heartbeat
    case sleep
    case wake
}

private struct MacEventPayload: Codable {
    let bootId: String
    let sequence: Int64
    let event: MacReportEvent
}

private enum ReporterError: Error {
    case invalidBootTime
    case invalidToken
    case invalidSequence
    case requestEncoding
}

private func currentBootID() throws -> String {
    var bootTime = timeval()
    var size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &bootTime, &size, nil, 0) == 0 else {
        throw ReporterError.invalidBootTime
    }
    return "mac-\(Int64(bootTime.tv_sec))"
}

private func loadToken(at url: URL) throws -> String {
    var item = stat()
    guard lstat(url.path, &item) == 0,
          (item.st_mode & S_IFMT) == S_IFREG,
          item.st_mode & 0o077 == 0,
          item.st_uid == uid_t(getuid()) else { throw ReporterError.invalidToken }
    let token = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    guard (32...512).contains(token.utf8.count), token.utf8.allSatisfy({
        ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
    }) else { throw ReporterError.invalidToken }
    return token
}

private final class SequenceStore {
    private let fileURL: URL
    private let lock = NSLock()

    init(fileURL: URL) { self.fileURL = fileURL }

    func next(uptimeSeconds suppliedUptime: Int64? = nil) throws -> Int64 {
        lock.lock()
        defer { lock.unlock() }

        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        var previous: Int64 = 0
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777
            let owner = (attributes[.ownerAccountID] as? NSNumber)?.intValue
            guard mode & 0o077 == 0, owner == Int(getuid()),
                  let stored = Int64(try String(contentsOf: fileURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)),
                  stored > 0 else { throw ReporterError.invalidSequence }
            previous = stored
        }
        guard previous < Int64.max else { throw ReporterError.invalidSequence }
        let uptime = suppliedUptime ?? Int64(ProcessInfo.processInfo.systemUptime.rounded(.down))
        let sequence = max(1, max(uptime, previous + 1))
        try String(sequence).write(to: fileURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        return sequence
    }
}

private func encodeEvent(bootId: String, sequence: Int64, event: MacReportEvent) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(MacEventPayload(bootId: bootId, sequence: sequence, event: event))
}

private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private final class RequestOutcome: @unchecked Sendable {
    let completed = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var accepted = false

    func finish(accepted: Bool) {
        lock.lock()
        self.accepted = accepted
        lock.unlock()
        completed.signal()
    }

    func result() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return accepted
    }
}

private final class MacReporter: NSObject {
    private static let endpoint = URL(string: "https://control.76.13.161.248.sslip.io/api/mac/events")!
    private static let heartbeatInterval: TimeInterval = 15
    private static let sleepWaitLimit: TimeInterval = 1

    private let bootId: String
    private let token: String
    private let sequences: SequenceStore
    private let redirectBlocker = RedirectBlocker()
    private let taskLock = NSLock()
    private var activeTask: URLSessionDataTask?
    private var activeRequestId: UUID?
    private var heartbeatTimer: Timer?
    private var observers: [NSObjectProtocol] = []
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: redirectBlocker, delegateQueue: nil)
    }()

    private init(token: String, bootId: String, sequences: SequenceStore) {
        self.token = token
        self.bootId = bootId
        self.sequences = sequences
        super.init()
    }

    static func configuredReporter() throws -> MacReporter {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let token = try loadToken(at: home.appendingPathComponent(".config/infra-control/mac-report-token"))
        let bootId = try currentBootID()
        let sequences = SequenceStore(fileURL: home.appendingPathComponent("Library/Application Support/InfraControl/mac-sequence"))
        return MacReporter(token: token, bootId: bootId, sequences: sequences)
    }

    func start() {
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: NSWorkspace.shared, queue: .main) { [weak self] _ in
            _ = self?.send(.sleep, waitLimit: Self.sleepWaitLimit)
        })
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: NSWorkspace.shared, queue: .main) { [weak self] _ in
            _ = self?.send(.wake)
        })
        _ = send(.online)
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: Self.heartbeatInterval, repeats: true) { [weak self] _ in
            _ = self?.send(.heartbeat)
        }
    }

    @discardableResult
    private func send(_ event: MacReportEvent, waitLimit: TimeInterval = 0) -> Bool {
        taskLock.lock()
        if event == .heartbeat && activeTask != nil {
            taskLock.unlock()
            return false
        }
        taskLock.unlock()

        let sequence: Int64
        let body: Data
        do {
            sequence = try sequences.next()
            body = try encodeEvent(bootId: bootId, sequence: sequence, event: event)
        } catch { return false }

        var request = URLRequest(url: Self.endpoint, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let requestId = UUID()
        let outcome = RequestOutcome()
        taskLock.lock()
        if event == .heartbeat && activeTask != nil {
            taskLock.unlock()
            return false
        }
        let previousTask = activeTask
        let task = session.dataTask(with: request) { [weak self] _, response, error in
            let accepted = error == nil && (response as? HTTPURLResponse)?.statusCode == 204
            self?.finish(requestId: requestId, accepted: accepted, outcome: outcome)
        }
        activeTask = task
        activeRequestId = requestId
        taskLock.unlock()
        previousTask?.cancel()
        task.resume()

        guard waitLimit > 0 else { return true }
        guard outcome.completed.wait(timeout: .now() + waitLimit) == .success else {
            task.cancel()
            return false
        }
        return outcome.result()
    }

    private func finish(requestId: UUID, accepted: Bool, outcome: RequestOutcome) {
        taskLock.lock()
        if activeRequestId == requestId {
            activeTask = nil
            activeRequestId = nil
        }
        taskLock.unlock()
        outcome.finish(accepted: accepted)
    }
}

private func runSelfTest() throws {
    _ = try currentBootID()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("infra-control-swift-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }

    let sequenceFile = directory.appendingPathComponent("sequence")
    let firstStore = SequenceStore(fileURL: sequenceFile)
    guard try firstStore.next(uptimeSeconds: 100) == 100,
          try firstStore.next(uptimeSeconds: 100) == 101,
          try SequenceStore(fileURL: sequenceFile).next(uptimeSeconds: 99) == 102 else {
        throw ReporterError.invalidSequence
    }

    let data = try encodeEvent(bootId: "mac-test-boot", sequence: 102, event: .sleep)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(["bootId", "sequence", "event"]),
          object["bootId"] as? String == "mac-test-boot",
          object["sequence"] as? Int == 102,
          object["event"] as? String == "sleep" else {
        throw ReporterError.requestEncoding
    }

    let tokenURL = directory.appendingPathComponent("token")
    try String(repeating: "T", count: 48).write(to: tokenURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
    guard try loadToken(at: tokenURL) == String(repeating: "T", count: 48) else { throw ReporterError.invalidToken }
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tokenURL.path)
    guard (try? loadToken(at: tokenURL)) == nil else { throw ReporterError.invalidToken }

    print("self-test: passed")
}

let reporterArguments = Array(CommandLine.arguments.dropFirst())
if reporterArguments == ["--self-test"] {
    do { try runSelfTest() }
    catch { fputs("self-test: failed\n", stderr); exit(EXIT_FAILURE) }
} else if reporterArguments == ["--check-config"] {
    do {
        _ = try MacReporter.configuredReporter()
        print("configuration: valid")
    } catch {
        fputs("reporter configuration invalid\n", stderr)
        exit(EXIT_FAILURE)
    }
} else if reporterArguments.isEmpty {
    do {
        let reporter = try MacReporter.configuredReporter()
        reporter.start()
        RunLoop.main.run()
    } catch {
        fputs("reporter configuration invalid\n", stderr)
        exit(EXIT_FAILURE)
    }
} else {
    fputs("unsupported reporter argument\n", stderr)
    exit(EXIT_FAILURE)
}
