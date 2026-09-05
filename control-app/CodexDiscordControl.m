#import <Cocoa/Cocoa.h>
#import <Security/Security.h>
#import <libproc.h>
#import <sys/sysctl.h>
#import <signal.h>
#import <unistd.h>
#import <sys/file.h>
#import <sys/stat.h>
#import <fcntl.h>

static void PrintJSON(id object) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    if(data){fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}
}
static NSDictionary *ProcessInfo(pid_t pid) {
    struct proc_bsdinfo info;
    if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info))return nil;
    if(info.pbi_uid!=getuid())return nil;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if(proc_pidpath(pid,executable,sizeof(executable))<=0)return nil;
    char resolved[PATH_MAX];if(!realpath(executable,resolved))return nil;
    int mib[]={CTL_KERN,KERN_PROCARGS2,pid};size_t length=0;
    if(sysctl(mib,3,NULL,&length,NULL,0)!=0||length>1048576||length<sizeof(int))return nil;
    char *buffer=calloc(1,length);if(!buffer)return nil;
    if(sysctl(mib,3,buffer,&length,NULL,0)!=0){free(buffer);return nil;}
    int count=*(int*)buffer;char *cursor=buffer+sizeof(int),*end=buffer+length;
    while(cursor<end&&*cursor)cursor++;while(cursor<end&&!*cursor)cursor++;
    NSMutableArray *arguments=[NSMutableArray array];
    for(int i=0;i<count&&cursor<end;i++){
        char *zero=memchr(cursor,0,end-cursor);if(!zero)break;
        NSString *argument=[[NSString alloc]initWithBytes:cursor length:zero-cursor encoding:NSUTF8StringEncoding];
        if(!argument){free(buffer);return nil;}[arguments addObject:argument];cursor=zero+1;
    }
    free(buffer);if(arguments.count!=count)return nil;
    return @{ @"pid":@(pid),@"uid":@(info.pbi_uid),@"ppid":@(info.pbi_ppid),@"pgid":@(info.pbi_pgid),
        @"executable":@(resolved),@"argv":arguments,
        @"startToken":[NSString stringWithFormat:@"%llu:%llu",info.pbi_start_tvsec,info.pbi_start_tvusec] };
}
static BOOL CodexSameProcess(NSDictionary *a,NSDictionary *b) {
    return a&&b&&[a[@"pid"] isEqual:b[@"pid"]]&&[a[@"uid"] isEqual:b[@"uid"]]&&[a[@"startToken"] isEqual:b[@"startToken"]]&&[a[@"executable"] isEqual:b[@"executable"]];
}
static BOOL TrustedApp(NSRunningApplication *app) {
    if(![app.bundleIdentifier isEqual:@"com.openai.codex"]||!app.bundleURL||!app.executableURL)return NO;
    NSDictionary *process=ProcessInfo(app.processIdentifier);if(!process)return NO;
    NSString *expected=app.executableURL.URLByResolvingSymlinksInPath.path;
    if(![process[@"executable"] isEqual:expected])return NO;
    NSString *bundle=app.bundleURL.URLByResolvingSymlinksInPath.path;
    if(![expected hasPrefix:[bundle stringByAppendingString:@"/Contents/MacOS/"]])return NO;
    SecStaticCodeRef code=NULL;SecRequirementRef requirement=NULL;
    OSStatus status=SecStaticCodeCreateWithPath((__bridge CFURLRef)app.bundleURL,kSecCSDefaultFlags,&code);
    if(status!=errSecSuccess)return NO;
    status=SecRequirementCreateWithString(CFSTR("anchor apple generic and identifier \"com.openai.codex\" and certificate leaf[subject.OU] = \"2DC432GLL2\""),kSecCSDefaultFlags,&requirement);
    if(status==errSecSuccess)status=SecStaticCodeCheckValidity(code,kSecCSStrictValidate,requirement);
    if(requirement)CFRelease(requirement);CFRelease(code);return status==errSecSuccess;
}
static NSArray *OwnProcesses(void) {
    int bytes=proc_listpids(PROC_UID_ONLY,getuid(),NULL,0);if(bytes<=0)return @[];
    pid_t *pids=calloc(1,bytes+4096);if(!pids)return @[];
    bytes=proc_listpids(PROC_UID_ONLY,getuid(),pids,bytes+4096);
    NSMutableArray *result=[NSMutableArray array];
    for(int i=0;i<bytes/(int)sizeof(pid_t);i++){if(pids[i]>1){NSDictionary *p=ProcessInfo(pids[i]);if(p)[result addObject:p];}}
    free(pids);return result;
}
static NSArray *Descendants(NSArray *roots,NSArray *all) {
    NSMutableArray *ordered=[NSMutableArray arrayWithArray:roots];NSMutableSet *seen=[NSMutableSet set];
    for(NSDictionary *root in roots)[seen addObject:root[@"pid"]];
    for(NSUInteger i=0;i<ordered.count;i++){
        NSDictionary *parent=ordered[i];
        for(NSDictionary *candidate in all)if([candidate[@"ppid"]isEqual:parent[@"pid"]]&&![seen containsObject:candidate[@"pid"]]){[ordered addObject:candidate];[seen addObject:candidate[@"pid"]];}
    }
    return ordered;
}
static NSArray *VerifiedCleanupTree(NSArray *original,NSArray *survivingRoots,NSArray *current) {
    NSMutableDictionary *currentByPID=[NSMutableDictionary dictionary];
    for(NSDictionary *p in current)currentByPID[p[@"pid"]]=p;
    NSMutableArray *verified=[NSMutableArray array];NSMutableSet *seen=[NSMutableSet set];
    // Previously verified descendants stay owned when graceful quit reparents them.
    for(NSDictionary *p in original){
        NSDictionary *live=currentByPID[p[@"pid"]];if(!live)continue;
        if(!CodexSameProcess(p,live))return nil;
        [verified addObject:live];[seen addObject:live[@"pid"]];
    }
    NSArray *seeds=[verified arrayByAddingObjectsFromArray:survivingRoots];
    for(NSDictionary *p in Descendants(seeds,current))if(![seen containsObject:p[@"pid"]]){
        [verified addObject:p];[seen addObject:p[@"pid"]];
    }
    return verified;
}
static NSUInteger WaitForProcessTreeExit(NSArray *tree,NSTimeInterval timeout) {
    NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:timeout];
    for(;;){
        NSUInteger remaining=0;
        for(NSDictionary *p in tree)if(CodexSameProcess(p,ProcessInfo([p[@"pid"]intValue])))remaining++;
        if(remaining==0||deadline.timeIntervalSinceNow<=0)return remaining;
        usleep(50000);
    }
}
static NSDictionary *DesktopAction(BOOL stop) {
    NSMutableArray *apps=[NSMutableArray array],*roots=[NSMutableArray array];
    for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications){
        if(![app.bundleIdentifier isEqual:@"com.openai.codex"])continue;
        if(!TrustedApp(app))return @{ @"ok":@NO,@"errorCategory":@"process-tree-unverifiable" };
        NSDictionary *p=ProcessInfo(app.processIdentifier);if(!p)return @{ @"ok":@NO,@"errorCategory":@"process-tree-unverifiable" };
        [apps addObject:app];[roots addObject:p];
    }
    NSArray *tree=Descendants(roots,OwnProcesses());
    if(!stop)return @{ @"ok":@YES,@"desktop":@{ @"running":(roots.count>0?@YES:@NO),@"processCount":@(tree.count),@"state":@"ready" }};
    for(NSUInteger i=0;i<apps.count;i++){
        NSRunningApplication *app=apps[i];if(!TrustedApp(app)||!CodexSameProcess(roots[i],ProcessInfo(app.processIdentifier)))return @{ @"ok":@NO,@"errorCategory":@"process-revalidation-failed" };
        [app terminate];
    }
    NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:3.0];
    while([deadline timeIntervalSinceNow]>0){BOOL alive=NO;for(NSDictionary *p in roots)if(CodexSameProcess(p,ProcessInfo([p[@"pid"]intValue])))alive=YES;if(!alive)break;usleep(100000);}
    NSMutableArray *survivors=[NSMutableArray array];
    for(NSUInteger i=0;i<roots.count;i++){
        NSDictionary *root=roots[i],*current=ProcessInfo([root[@"pid"]intValue]);
        if(!current)continue;
        if(!CodexSameProcess(root,current)||!TrustedApp(apps[i]))return @{ @"ok":@NO,@"errorCategory":@"process-revalidation-failed" };
        [survivors addObject:current];
    }
    NSArray *after=VerifiedCleanupTree(tree,survivors,OwnProcesses());NSUInteger stopped=0;
    if(!after)return @{ @"ok":@NO,@"errorCategory":@"process-revalidation-failed" };
    for(NSDictionary *p in after.reverseObjectEnumerator){
        NSDictionary *current=ProcessInfo([p[@"pid"]intValue]);if(!current)continue;
        if(!CodexSameProcess(p,current))return @{ @"ok":@NO,@"errorCategory":@"process-revalidation-failed",@"stoppedProcessCount":@(stopped) };
        if(kill([p[@"pid"]intValue],SIGKILL)!=0&&errno!=ESRCH)return @{ @"ok":@NO,@"errorCategory":@"process-control-failed" };stopped++;
    }
    NSUInteger remaining=WaitForProcessTreeExit(after,2.0);
    return @{ @"ok":(remaining==0?@YES:@NO),@"alreadyStopped":(roots.count==0?@YES:@NO),@"stoppedProcessCount":@(stopped),@"remainingCount":@(remaining),@"verifiedCount":@(tree.count) };
}

@interface ControlDelegate : NSObject <NSApplicationDelegate>
@property NSWindow *window;
@property NSMutableArray<NSTextField*> *values;
@property NSMutableArray<NSButton*> *buttons;
@property NSTextField *result;
@property BOOL busy;
@end
@implementation ControlDelegate
-(NSTextField*)label:(NSString*)text {NSTextField *v=[NSTextField labelWithString:text];v.font=[NSFont systemFontOfSize:14];return v;}
-(void)applicationDidFinishLaunching:(NSNotification*)note {
    self.window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,700,410) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
    self.window.title=@"Codex Discord 控制台";[self.window center];
    NSView *view=self.window.contentView;
    NSTextField *title=[self label:@"Discord 桥接服务"];title.font=[NSFont boldSystemFontOfSize:23];title.frame=NSMakeRect(25,355,630,32);[view addSubview:title];
    NSArray *captions=@[@"桥接服务",@"登录自启",@"Codex 桌面端",@"Discord",@"最近活动",@"继续队列"];
    self.values=[NSMutableArray array];
    for(NSUInteger i=0;i<captions.count;i++){NSTextField *key=[self label:captions[i]];key.frame=NSMakeRect(25,310-i*37,170,25);[view addSubview:key];NSTextField *value=[self label:@"未知"];value.frame=NSMakeRect(195,310-i*37,475,25);[view addSubview:value];[self.values addObject:value];}
    self.buttons=[NSMutableArray array];NSArray *names=@[@"临时开启",@"临时停止",@"长期开启",@"长期停用",@"刷新"];
    for(NSUInteger i=0;i<names.count;i++){NSButton *button=[NSButton buttonWithTitle:names[i] target:self action:@selector(click:)];button.tag=i;button.frame=NSMakeRect(20+i*133,67,128,34);[view addSubview:button];[self.buttons addObject:button];}
    self.result=[self label:@"正在读取状态…"];self.result.frame=NSMakeRect(25,25,650,27);[view addSubview:self.result];
    [self.window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];
    [NSTimer scheduledTimerWithTimeInterval:2.0 target:self selector:@selector(refresh) userInfo:nil repeats:YES];[self refresh];
}
-(BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender{return YES;}
-(NSDictionary*)run:(NSString*)action {
    NSString *bundle=NSBundle.mainBundle.bundlePath,*tool=[bundle stringByDeletingLastPathComponent];
    NSString *node=[NSBundle.mainBundle objectForInfoDictionaryKey:@"CodexDiscordNodePath"];
    if(!node||![[NSFileManager defaultManager]isExecutableFileAtPath:node])return nil;
    NSTask *task=[NSTask new];task.executableURL=[NSURL fileURLWithPath:node];task.currentDirectoryURL=[NSURL fileURLWithPath:tool];
    NSMutableDictionary *environment=[NSMutableDictionary dictionaryWithDictionary:NSProcessInfo.processInfo.environment];
    NSDictionary *saved=[NSBundle.mainBundle objectForInfoDictionaryKey:@"CodexDiscordEnvironment"];
    if([saved isKindOfClass:NSDictionary.class])[environment addEntriesFromDictionary:saved];task.environment=environment;
    task.arguments=@[[tool stringByAppendingPathComponent:@"discord-macos-control.mjs"],@"--action",action];
    NSPipe *pipe=[NSPipe pipe];task.standardOutput=pipe;task.standardError=[NSFileHandle fileHandleWithNullDevice];NSError *error=nil;
    if(![task launchAndReturnError:&error])return nil;
    NSMutableData *data=[NSMutableData data];__block BOOL oversized=NO;
    dispatch_group_t group=dispatch_group_create();dispatch_group_enter(group);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{while(YES){NSData *chunk=[pipe.fileHandleForReading availableData];if(chunk.length==0)break;if(data.length+chunk.length>65536){oversized=YES;[task terminate];break;}[data appendData:chunk];}dispatch_group_leave(group);});
    NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:20];while(task.running&&deadline.timeIntervalSinceNow>0)usleep(20000);
    if(task.running){[task terminate];usleep(200000);if(task.running)kill(task.processIdentifier,SIGKILL);return nil;}
    if(dispatch_group_wait(group,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))!=0||oversized||task.terminationStatus!=0)return nil;
    id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];return [value isKindOfClass:NSDictionary.class]?value:nil;
}
-(void)apply:(NSDictionary*)status {
    if(![status[@"ok"]boolValue]){for(NSTextField *v in self.values)v.stringValue=@"未知";return;}
    NSDictionary *service=status[@"service"],*desktop=status[@"desktop"],*discord=status[@"discord"];
    self.values[0].stringValue=[NSString stringWithFormat:@"%@ · %@",[service[@"mode"]isEqual:@"scheduled"]?@"登录服务":[service[@"mode"]isEqual:@"temporary"]?@"临时运行":@"未知",[service[@"running"]boolValue]?@"运行中":@"已停止"];
    self.values[1].stringValue=[service[@"autoStartEnabled"]boolValue]?@"已开启":@"已停用";
    self.values[2].stringValue=[desktop[@"state"]isEqual:@"unknown"]?@"未知":[desktop[@"running"]boolValue]?@"运行中":@"未运行";
    NSDictionary *states=@{@"ready":@"已连接",@"ok":@"正常",@"connecting":@"连接中",@"reconnecting":@"重连中",@"offline":@"已断开",@"stopped":@"已停止",@"failed":@"故障"};
    self.values[3].stringValue=[NSString stringWithFormat:@"Gateway：%@ · REST：%@",states[discord[@"state"]]?:@"未知",states[discord[@"restState"]]?:@"未知"];
    self.values[4].stringValue=[discord[@"lastActivityAt"]isKindOfClass:NSString.class]?discord[@"lastActivityAt"]:@"未知";
    self.values[5].stringValue=[discord[@"queueState"]isEqual:@"unknown"]?@"未知":[NSString stringWithFormat:@"%@ 条",status[@"queueCount"]?:@0];
}
-(void)perform:(NSString*)action {
    if(self.busy)return;self.busy=YES;for(NSButton *b in self.buttons)b.enabled=NO;
    BOOL statusOnly=[action isEqual:@"status"];if(!statusOnly)self.result.stringValue=@"正在执行…";
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{NSDictionary *result=[self run:action];NSDictionary *status=statusOnly?result:[self run:@"status"];dispatch_async(dispatch_get_main_queue(),^{[self apply:status];self.result.stringValue=[result[@"ok"]boolValue]?([status[@"ok"]boolValue]?(statusOnly?@"状态已更新。":@"操作已完成。"):@"操作已完成，但状态刷新失败。"):@"操作失败，请检查控制后端。";self.busy=NO;for(NSButton *b in self.buttons)b.enabled=YES;});});
}
-(void)refresh{[self perform:@"status"];}
-(void)click:(NSButton*)sender {
    NSArray *actions=@[@"start-temporary",@"stop-temporary",@"enable-long-term",@"disable-long-term",@"status"];
    if(sender.tag==3){NSAlert *alert=[NSAlert new];alert.messageText=@"确认长期停用";alert.informativeText=@"这将停止桥接服务，并关闭今后的登录自启。Token、队列和历史均保留。";[alert addButtonWithTitle:@"取消"];[alert addButtonWithTitle:@"长期停用"];if([alert runModal]!=NSAlertSecondButtonReturn)return;}
    [self perform:actions[sender.tag]];
}
@end
int main(int argc,const char *argv[]) {
    @autoreleasepool {
        if(argc==2&&!strcmp(argv[1],"--hold-lock")){
            NSString *tool=[NSBundle.mainBundle.bundlePath stringByDeletingLastPathComponent];
            NSString *lockPath=[tool stringByAppendingPathComponent:@".discord-macos-supervisor.lock"];
            int fd=open(lockPath.fileSystemRepresentation,O_RDWR|O_CREAT|O_NOFOLLOW,0600);struct stat st;
            if(fd<0||fstat(fd,&st)!=0||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||(st.st_mode&0022)||flock(fd,LOCK_EX|LOCK_NB)!=0){if(fd>=0)close(fd);return 1;}
            fputs("locked\n",stdout);fflush(stdout);char byte;while(read(STDIN_FILENO,&byte,1)>0){}close(fd);return 0;
        }
        if(argc==3&&!strcmp(argv[1],"--process-group")){
            char *end=NULL;long group=strtol(argv[2],&end,10);if(!end||*end||group<=1||group>INT_MAX)return 1;
            NSMutableArray *members=[NSMutableArray array];for(NSDictionary *p in OwnProcesses())if([p[@"pgid"]intValue]==group)[members addObject:p];PrintJSON(members);return 0;
        }
        if(argc==3&&!strcmp(argv[1],"--process-info")){char *end=NULL;long pid=strtol(argv[2],&end,10);NSDictionary *p=(end&&!*end&&pid>1&&pid<=INT_MAX)?ProcessInfo((pid_t)pid):nil;PrintJSON(p?:@{@"ok":@NO});return p?0:1;}
        if(argc==2&&(!strcmp(argv[1],"--desktop-status")||!strcmp(argv[1],"--stop-desktop"))){NSDictionary *value=DesktopAction(!strcmp(argv[1],"--stop-desktop"));PrintJSON(value);return [value[@"ok"]boolValue]?0:1;}
        if(argc!=1){PrintJSON(@{@"ok":@NO,@"errorCategory":@"invalid-arguments"});return 2;}
        [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];ControlDelegate *delegate=[ControlDelegate new];NSApp.delegate=delegate;[NSApp run];
    }return 0;
}
