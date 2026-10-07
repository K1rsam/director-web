//! A desktop launched by a packaged host must use the same filesystem as an Explorer launch.
//! Run this before creating the webview, project registry, workers, or CLI processes.

#[cfg(windows)]
mod windows {
    use std::{
        ffi::{c_void, OsStr},
        mem::size_of,
        os::windows::ffi::OsStrExt,
        ptr,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct StartupInfo {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_count: u32,
        y_count: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_bytes: *mut u8,
        input: Handle,
        output: Handle,
        error: Handle,
    }
    #[repr(C)]
    struct StartupInfoEx {
        startup: StartupInfo,
        attributes: Handle,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ProcessInfo {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentPackageFamilyName(length: *mut u32, name: *mut u16) -> i32;
        fn InitializeProcThreadAttributeList(
            list: Handle,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: Handle,
            flags: u32,
            key: usize,
            value: Handle,
            size: usize,
            previous: Handle,
            returned: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: Handle);
        fn CreateProcessW(
            app: *const u16,
            command: *mut u16,
            pa: Handle,
            ta: Handle,
            inherit: i32,
            flags: u32,
            environment: Handle,
            directory: *const u16,
            startup: *mut StartupInfoEx,
            info: *mut ProcessInfo,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub fn is_packaged() -> Result<bool, String> {
        let mut length = 0;
        match unsafe { GetCurrentPackageFamilyName(&mut length, ptr::null_mut()) } {
            15700 => Ok(false), // APPMODEL_ERROR_NO_PACKAGE
            0 | 122 => Ok(true),
            error => Err(format!("无法识别桌面运行环境（Windows {error}）")),
        }
    }
    fn quote(value: &OsStr) -> Vec<u16> {
        let mut out = vec![b'"' as u16];
        let mut slashes = 0;
        for unit in value.encode_wide() {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            out.extend(std::iter::repeat_n(
                b'\\' as u16,
                if unit == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            out.push(unit);
            slashes = 0;
        }
        out.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        out.push(b'"' as u16);
        out
    }
    pub fn ensure_unvirtualized() -> Result<bool, String> {
        if !is_packaged()? {
            return Ok(false);
        }
        if std::env::args_os().any(|arg| arg == "--unvirtualized-desktop") {
            return Err("Windows 未完成共享桌面环境切换；已停止重启，避免循环启动".into());
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_wide: Vec<_> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut command = quote(exe.as_os_str());
        for argument in std::env::args_os().skip(1) {
            command.push(b' ' as u16);
            command.extend(quote(&argument));
        }
        command.push(b' ' as u16);
        command.extend(quote(OsStr::new("--unvirtualized-desktop")));
        command.push(0);
        let directory = std::env::current_dir().map_err(|e| e.to_string())?;
        let directory_wide: Vec<_> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // Windows requires aligned storage for its opaque attribute list.
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let attributes = storage.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut bytes) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let result = (|| {
            let mut policy: u32 = 1; // PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE
            if unsafe {
                UpdateProcThreadAttribute(
                    attributes,
                    0,
                    0x20012,
                    (&mut policy as *mut u32).cast(),
                    size_of::<u32>(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut startup = StartupInfoEx {
                startup: StartupInfo {
                    cb: size_of::<StartupInfoEx>() as u32,
                    ..Default::default()
                },
                attributes,
            };
            let mut info = ProcessInfo::default();
            if unsafe {
                CreateProcessW(
                    exe_wide.as_ptr(),
                    command.as_mut_ptr(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    0,
                    0x08080000,
                    ptr::null_mut(),
                    directory_wide.as_ptr(),
                    &mut startup,
                    &mut info,
                )
            } == 0
            {
                return Err(format!(
                    "无法以共享项目环境启动桌面端：{}",
                    std::io::Error::last_os_error()
                ));
            }
            unsafe {
                CloseHandle(info.thread);
                CloseHandle(info.process);
            }
            Ok(true)
        })();
        unsafe {
            DeleteProcThreadAttributeList(attributes);
        }
        result
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn windows_arguments_preserve_spaces_quotes_and_trailing_slashes() {
            let rendered = |text: &str| String::from_utf16(&quote(OsStr::new(text))).unwrap();
            assert_eq!(rendered(""), "\"\"");
            assert_eq!(rendered("项目 1"), "\"项目 1\"");
            assert_eq!(rendered("a\\\"b"), "\"a\\\\\\\"b\"");
            assert_eq!(rendered("C:\\项目\\"), "\"C:\\项目\\\\\"");
        }
    }
}

#[cfg(windows)]
pub use windows::{ensure_unvirtualized, is_packaged};
#[cfg(not(windows))]
pub fn ensure_unvirtualized() -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(windows))]
pub fn is_packaged() -> Result<bool, String> {
    Ok(false)
}
