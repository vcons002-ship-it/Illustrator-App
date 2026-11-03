//! A cached address is not proof that the managed server is still running.
//! Keep the health check, stale-child cleanup and launch under one lock so desktop,
//! worker and phone Connect requests cannot race into duplicate GPU processes.
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) fn wait_until_ready(
    child: &mut Child,
    healthy: impl Fn() -> bool,
    cancelled: impl Fn() -> bool,
    timeout: Duration,
    interval: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled() {
            return Err("Engine startup cancelled because the desktop is closing".into());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("Could not inspect engine process: {err}"))?
        {
            return Err(format!("Engine process exited with {status}"));
        }
        if healthy() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "API did not become ready within {} seconds",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(interval.min(deadline.saturating_duration_since(Instant::now())));
    }
}

#[derive(Default)]
struct EngineSlot {
    base_url: Option<String>,
    child: Option<Child>,
}

#[derive(Default)]
pub(crate) struct ManagedEngine {
    slot: Mutex<EngineSlot>,
    stopping: AtomicBool,
}

impl ManagedEngine {
    pub(crate) fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub(crate) fn ensure_running(
        &self,
        endpoint: &str,
        healthy: impl FnOnce(&str) -> bool,
        launch: impl FnOnce() -> Result<(String, Option<Child>), String>,
    ) -> Result<String, String> {
        let mut slot = self
            .slot
            .lock()
            .map_err(|_| "Engine lifecycle lock was poisoned")?;
        if self.is_stopping() {
            return Err("The desktop is closing; no engine was started".into());
        }
        if let Some(child) = slot.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => slot.child = None, // reap the old handle, never taskkill a reused PID
                Ok(None) => {}
                Err(err) => {
                    return Err(format!(
                        "Could not inspect the managed ComfyUI process: {err}"
                    ))
                }
            }
        }
        let base = slot.base_url.as_deref().unwrap_or(endpoint);
        if healthy(base) {
            let base = base.to_string();
            slot.base_url = Some(base.clone());
            return Ok(base);
        }
        slot.base_url = None;
        if let Some(child) = slot.child.as_ref() {
            // A slow/busy API is not permission to kill a live render or start a second engine.
            return Err(format!(
                "ComfyUI process {} is still running but its API is not responding at {endpoint}. \
                 No duplicate engine was started. Wait for it to finish starting, then retry Connect; \
                 if it stays unresponsive, inspect the engine console or comfyui-engine.log.",
                child.id()
            ));
        }
        let (base, child) = launch()?;
        slot.base_url = Some(base.clone());
        slot.child = child;
        Ok(base)
    }

    pub(crate) fn stop(&self, stop_child: impl FnOnce(&mut Child)) {
        // Interrupt readiness polling before waiting for the lifecycle lock, rather
        // than making app shutdown wait for the full three-minute startup timeout.
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.slot.lock() {
            slot.base_url = None;
            if let Some(mut child) = slot.child.take() {
                // Reap an exited child without targeting its numeric PID again.
                if !matches!(child.try_wait(), Ok(Some(_))) {
                    stop_child(&mut child);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};

    const ENDPOINT: &str = "http://127.0.0.1:8188";

    fn cached() -> ManagedEngine {
        ManagedEngine {
            slot: Mutex::new(EngineSlot {
                base_url: Some(ENDPOINT.into()),
                child: None,
            }),
            stopping: AtomicBool::new(false),
        }
    }

    fn fixture(mode: &str) -> Child {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        let fixture_name = format!(
            "{}::child_fixture",
            module_path!().split_once("::").unwrap().1
        );
        cmd.args(["--ignored", "--exact", &fixture_name])
            .env("VR_ENGINE_FIXTURE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.spawn().unwrap()
    }

    #[test]
    #[ignore = "subprocess fixture; spawned only by lifecycle tests"]
    fn child_fixture() {
        match std::env::var("VR_ENGINE_FIXTURE").as_deref() {
            Ok("exit") => std::process::exit(7),
            Ok("alive") => std::thread::sleep(Duration::from_secs(30)),
            _ => panic!("fixture must only run as an explicitly configured subprocess"),
        }
    }

    #[test]
    fn healthy_cached_endpoint_is_probed_and_reused() {
        let engine = cached();
        assert_eq!(
            engine
                .ensure_running(
                    ENDPOINT,
                    |url| {
                        assert_eq!(url, ENDPOINT);
                        true
                    },
                    || panic!("healthy server must not be relaunched")
                )
                .unwrap(),
            ENDPOINT
        );
    }

    #[test]
    fn stopped_external_server_invalidates_cached_address_and_relaunches() {
        let engine = cached();
        let launches = AtomicUsize::new(0);
        assert_eq!(
            engine
                .ensure_running(
                    ENDPOINT,
                    |_| false,
                    || {
                        launches.fetch_add(1, Ordering::SeqCst);
                        Ok((ENDPOINT.into(), None))
                    }
                )
                .unwrap(),
            ENDPOINT
        );
        assert_eq!(launches.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_relaunch_does_not_keep_a_false_ready_cache_and_can_retry() {
        let engine = cached();
        assert!(engine
            .ensure_running(ENDPOINT, |_| false, || Err("Python exited: code 1".into()))
            .is_err());
        assert!(engine.slot.lock().unwrap().base_url.is_none());
        assert!(engine
            .ensure_running(ENDPOINT, |_| false, || Ok((ENDPOINT.into(), None)))
            .is_ok());
    }

    fn exited_child() -> Child {
        let mut child = fixture("exit");
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "fixture did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        child
    }

    #[test]
    fn exited_managed_child_is_reaped_then_relaunched() {
        let engine = cached();
        engine.slot.lock().unwrap().child = Some(exited_child());
        assert!(engine
            .ensure_running(ENDPOINT, |_| false, || Ok((ENDPOINT.into(), None)))
            .is_ok());
        assert!(engine.slot.lock().unwrap().child.is_none());
    }

    #[test]
    fn external_replacement_is_reused_after_owned_process_exits() {
        let engine = cached();
        engine.slot.lock().unwrap().child = Some(exited_child());
        assert!(engine
            .ensure_running(ENDPOINT, |_| true, || panic!("must reuse replacement"))
            .is_ok());
        assert!(engine.slot.lock().unwrap().child.is_none());
    }

    #[test]
    fn unresponsive_live_child_is_not_killed_or_duplicated() {
        let engine = cached();
        engine.slot.lock().unwrap().child = Some(fixture("alive"));
        let result =
            engine.ensure_running(ENDPOINT, |_| false, || panic!("must not spawn duplicate"));
        engine.stop(|child| {
            let _ = child.kill();
            let _ = child.wait();
        });
        assert!(result.unwrap_err().contains("still running"));
    }

    #[test]
    fn concurrent_reconnects_launch_exactly_once() {
        let engine = Arc::new(cached());
        let ready = Arc::new(AtomicBool::new(false));
        let launches = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (engine, ready, launches) = (engine.clone(), ready.clone(), launches.clone());
                std::thread::spawn(move || {
                    engine
                        .ensure_running(
                            ENDPOINT,
                            |_| ready.load(Ordering::SeqCst),
                            || {
                                launches.fetch_add(1, Ordering::SeqCst);
                                std::thread::sleep(Duration::from_millis(20));
                                ready.store(true, Ordering::SeqCst);
                                Ok((ENDPOINT.into(), None))
                            },
                        )
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), ENDPOINT);
        }
        assert_eq!(launches.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stopping_reused_external_engine_does_not_kill_it() {
        let engine = cached();
        engine.stop(|_| panic!("no owned process to stop"));
        assert!(engine.slot.lock().unwrap().base_url.is_none());
    }

    #[test]
    fn startup_exit_reports_status_without_waiting_for_full_timeout() {
        let mut child = exited_child();
        let before = Instant::now();
        let error = wait_until_ready(
            &mut child,
            || false,
            || false,
            Duration::from_secs(180),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(error.contains("exited with"));
        assert!(error.contains('7'));
        assert!(before.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn startup_wait_accepts_a_live_healthy_child() {
        let mut child = fixture("alive");
        let result = wait_until_ready(
            &mut child,
            || true,
            || false,
            Duration::from_secs(1),
            Duration::from_millis(10),
        );
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.is_ok());
    }

    #[test]
    fn startup_wait_has_a_bounded_deadline() {
        let mut child = fixture("alive");
        let result = wait_until_ready(
            &mut child,
            || false,
            || false,
            Duration::from_millis(20),
            Duration::from_millis(5),
        );
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.unwrap_err().contains("did not become ready"));
    }

    #[test]
    fn shutdown_cancels_readiness_without_waiting_for_timeout() {
        let mut child = fixture("alive");
        let result = wait_until_ready(
            &mut child,
            || false,
            || true,
            Duration::from_secs(180),
            Duration::from_secs(1),
        );
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.unwrap_err().contains("cancelled"));
    }

    #[test]
    fn ensure_after_shutdown_cannot_resurrect_an_engine() {
        let engine = cached();
        engine.stop(|_| panic!("no owned child"));
        assert!(engine
            .ensure_running(
                ENDPOINT,
                |_| panic!("already closing"),
                || panic!("must not launch")
            )
            .is_err());
    }

    #[test]
    fn live_process_recovers_on_next_connect_without_a_duplicate() {
        let engine = cached();
        engine.slot.lock().unwrap().child = Some(fixture("alive"));
        assert!(engine
            .ensure_running(ENDPOINT, |_| false, || panic!("must not duplicate"))
            .is_err());
        let recovered = engine.ensure_running(ENDPOINT, |_| true, || panic!("must reuse"));
        engine.stop(|child| {
            let _ = child.kill();
            let _ = child.wait();
        });
        assert_eq!(recovered.unwrap(), ENDPOINT);
    }

    /// Exercise the production lifecycle against real child processes and a real
    /// HTTP port, without stopping ComfyUI or loading a GPU model on the test box.
    #[test]
    #[ignore = "set VISUAL_READER_ENGINE_TEST_PYTHON to an existing Python executable"]
    fn live_http_server_restarts_after_owned_process_exits() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        let python = std::env::var_os("VISUAL_READER_ENGINE_TEST_PYTHON")
            .expect("explicit Python path required");
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);
        let endpoint = format!("http://{address}");
        let healthy = |_: &str| {
            let Ok(mut socket) = TcpStream::connect_timeout(&address, Duration::from_millis(100))
            else {
                return false;
            };
            let _ = socket.set_read_timeout(Some(Duration::from_millis(200)));
            if socket
                .write_all(b"GET /system_stats HTTP/1.0\r\nHost: localhost\r\n\r\n")
                .is_err()
            {
                return false;
            }
            let mut response = [0; 128];
            socket
                .read(&mut response)
                .map(|count| String::from_utf8_lossy(&response[..count]).contains(" 200 "))
                .unwrap_or(false)
        };
        let launches = AtomicUsize::new(0);
        let launch = || {
            let mut command = Command::new(&python);
            command.args(["-I", "-S", "-u", "-c",
                "import http.server,sys; H=type('H',(http.server.BaseHTTPRequestHandler,),{'do_GET':lambda self:(self.send_response(200),self.end_headers(),self.wfile.write(b'{}'))}); http.server.HTTPServer(('127.0.0.1',int(sys.argv[1])),H).serve_forever()",
                &address.port().to_string()])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn().map_err(|error| error.to_string())?;
            if let Err(error) = wait_until_ready(
                &mut child,
                || healthy(&endpoint),
                || false,
                Duration::from_secs(10),
                Duration::from_millis(20),
            ) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            launches.fetch_add(1, Ordering::SeqCst);
            Ok((endpoint.clone(), Some(child)))
        };
        struct Cleanup(ManagedEngine);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.stop(|child| {
                    let _ = child.kill();
                    let _ = child.wait();
                });
            }
        }
        let cleanup = Cleanup(ManagedEngine::default());
        let engine = &cleanup.0;
        assert_eq!(
            engine.ensure_running(&endpoint, healthy, launch).unwrap(),
            endpoint
        );
        assert_eq!(
            engine
                .ensure_running(&endpoint, healthy, || panic!(
                    "healthy server must be reused"
                ))
                .unwrap(),
            endpoint
        );
        let first_pid = {
            let mut slot = engine.slot.lock().unwrap();
            let child = slot.child.as_mut().unwrap();
            let id = child.id();
            child.kill().unwrap();
            child.wait().unwrap();
            id
        };
        assert!(!healthy(&endpoint));
        assert_eq!(
            engine.ensure_running(&endpoint, healthy, launch).unwrap(),
            endpoint
        );
        assert_ne!(
            engine.slot.lock().unwrap().child.as_ref().unwrap().id(),
            first_pid
        );
        assert!(healthy(&endpoint));
        assert_eq!(launches.load(Ordering::SeqCst), 2);
    }
}
